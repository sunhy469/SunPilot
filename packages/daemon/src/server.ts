import {
  appendFileSync,
  createReadStream,
  existsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";
import {
  approvalDecisionSchema,
  createRunSchema,
  type RunRecord,
  type MemoryRecord,
  type RunMode,
  type RunStatus,
} from "@sunpilot/protocol";
import {
  AgentService,
  DEFAULT_LLM_MODEL,
  createDefaultLlmProvider,
  McpProviderStub,
  parseAgentChatRequest,
  RepositoryAgentConversationStore,
  RepositoryApprovalExpiryService,
  RepositoryRuntimeStore,
  RuntimeError,
  LLM_API_KEY_ENV,
  LLM_MODEL_ENV,
  SkillProvider,
  SunPilotRuntime,
  DEEPSEEK_API_KEY_ENV,
} from "@sunpilot/core";
import { createAgentLoopService } from "./composition-root.js";
import { ConnectionRegistry } from "./connection-registry.js";
import { subscribeEventStreamer } from "./event-streamer.js";
import { JsonRpcRouter } from "./json-rpc-router.js";
import {
  agentErrorNotification,
  rpcError,
  websocketNotificationForEvent,
} from "./ws-protocol.js";
import { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";
import {
  createDatabaseContext,
  type DatabaseContext,
  DuckDbAdapterStub,
  ensureSunPilotHome,
  getSunPilotPaths,
  LanceDbAdapterStub,
  readSunPilotConfig,
  updateSunPilotConfig,
} from "@sunpilot/storage";
import { WorkflowRegistry } from "@sunpilot/workflow";

export interface DaemonOptions {
  port?: number;
  host?: string;
  chatAgent?: Pick<
    AgentService,
    | "handleChatCommand"
    | "stopChat"
    | "cancelRun"
    | "resumeRun"
    | "retryRun"
    | "approve"
    | "reject"
  >;
  database?: DatabaseContext;
}

const DEFAULT_EXTERNAL_ORIGINS = [
  "https://tradeagent.asia",
  "https://www.tradeagent.asia",
];
const AGENT_ACTIVE_STATUSES: RunStatus[] = [
  "created",
  "queued",
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "executing",
  "observing",
  "reflecting",
  "responding",
  "running",
  "paused",
];
const RUN_STATUSES: RunStatus[] = [
  "created",
  "queued",
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "waiting_approval",
  "executing",
  "observing",
  "reflecting",
  "responding",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];
const RUN_MODES: RunMode[] = [
  "chat",
  "agent",
  "workflow",
  "plan",
  "auto",
  "approval_required",
  "dry_run",
];
const METRIC_BUCKETS_MS = [100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];
const require = createRequire(import.meta.url);

function metricLabel(value: unknown): string {
  return String(value ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function pushHistogram(
  lines: string[],
  name: string,
  labels: Record<string, string>,
  values: number[],
): void {
  const withLabels = (extraLabels: Record<string, string> = {}) => {
    const parts = [
      ...Object.entries(labels).map(
        ([key, value]) => `${key}="${metricLabel(value)}"`,
      ),
      ...Object.entries(extraLabels).map(
        ([key, value]) => `${key}="${metricLabel(value)}"`,
      ),
    ];
    return parts.length > 0 ? `{${parts.join(",")}}` : "";
  };
  for (const bucket of METRIC_BUCKETS_MS) {
    const count = values.filter((value) => value <= bucket).length;
    lines.push(`${name}_bucket${withLabels({ le: String(bucket) })} ${count}`);
  }
  lines.push(`${name}_bucket${withLabels({ le: "+Inf" })} ${values.length}`);
  lines.push(`${name}_count${withLabels()} ${values.length}`);
  lines.push(
    `${name}_sum${withLabels()} ${values.reduce((sum, value) => sum + value, 0)}`,
  );
}

function allowedExternalOrigins(): Set<string> {
  return new Set(
    [
      DEFAULT_EXTERNAL_ORIGINS.join(","),
      process.env.SUNPILOT_ALLOWED_ORIGINS ?? "",
    ]
      .join(",")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function isAllowedLocalOrigin(
  origin: string | undefined,
  port: number,
  externalOrigins = allowedExternalOrigins(),
): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (externalOrigins.has(parsed.origin)) return true;
    const allowedPorts = new Set([String(port), "3737", "3738", ""]);
    return (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      allowedPorts.has(parsed.port)
    );
  } catch {
    return false;
  }
}

function chatHttpStatus(error: unknown): number {
  if (error instanceof RuntimeError) return error.statusCode;
  if (
    error instanceof Error &&
    (error.message.includes("request must be an object") ||
      error.message.includes("message is required") ||
      error.message.includes("conversationId must be"))
  ) {
    return 400;
  }
  return 500;
}

function conversationTitleFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const title = (body as { title?: unknown }).title;
  if (title === undefined) return undefined;
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("title must be a non-empty string when provided.");
  }
  return title.trim();
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function paginationCursor(input: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function parseRunStatus(value: string | undefined): RunStatus | undefined {
  if (!value) return undefined;
  const statuses: readonly RunStatus[] = [
    "created",
    "queued",
    "context_building",
    "intent_routing",
    "planning",
    "tool_deciding",
    "waiting_approval",
    "executing",
    "observing",
    "reflecting",
    "responding",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ];
  return statuses.includes(value as RunStatus)
    ? (value as RunStatus)
    : undefined;
}

function parseRunMode(value: string | undefined): RunMode | undefined {
  if (!value) return undefined;
  const modes: readonly RunMode[] = [
    "chat",
    "agent",
    "workflow",
    "plan",
    "auto",
    "approval_required",
    "dry_run",
  ];
  return modes.includes(value as RunMode) ? (value as RunMode) : undefined;
}

function shouldFallbackToRuntimeApproval(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return (
    code === "AGENT_APPROVAL_REQUIRED" ||
    code === "AGENT_APPROVAL_NOT_RESUMABLE"
  );
}

function parseApprovalStatus(
  value: string | undefined,
): "pending" | "approved" | "rejected" | "expired" | undefined {
  if (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "expired"
  ) {
    return value;
  }
  return undefined;
}

const AGENT_RECOVERY_INTERRUPT_STATUSES: readonly RunStatus[] = [
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "executing",
  "observing",
  "reflecting",
];

async function recoverAgentRuntimeRuns(database: DatabaseContext): Promise<{
  recoveredRuns: string[];
  interruptedRuns: string[];
  failedRuns: string[];
  snapshottedApprovals: string[];
}> {
  const now = new Date().toISOString();
  const recoveredRuns: string[] = [];
  const interruptedRuns: string[] = [];
  const failedRuns: string[] = [];
  const snapshottedApprovals: string[] = [];

  for (const status of AGENT_RECOVERY_INTERRUPT_STATUSES) {
    for (const run of await database.runs.list({ status, limit: 200 })) {
      await interruptRecoveredRun(database, run, now);
      recoveredRuns.push(run.id);
      interruptedRuns.push(run.id);
    }
  }

  for (const run of await database.runs.list({
    status: "responding",
    limit: 200,
  })) {
    const error = {
      code: "AGENT_RUN_RECOVERY_REQUIRED",
      message: "Daemon restarted while the run was responding.",
      category: "run_state",
      retryable: true,
    };
    await database.runs.updateStatus(run.id, "failed", now, error);
    await database.runStatusHistory.append({
      runId: run.id,
      previousStatus: run.status,
      nextStatus: "failed",
      reason: "daemon restarted during response generation",
      actor: "daemon",
      createdAt: now,
    });
    await database.events.append({
      id: `evt_${crypto.randomUUID()}`,
      runId: run.id,
      conversationId: run.conversationId,
      type: "agent.run.failed",
      payload: { runId: run.id, error },
      createdAt: now,
    });
    recoveredRuns.push(run.id);
    failedRuns.push(run.id);
  }

  for (const run of await database.runs.list({
    status: "waiting_approval",
    limit: 200,
  })) {
    const approvals = await database.approvals.list({
      runId: run.id,
      status: "pending",
      limit: 200,
    });
    for (const approval of approvals) {
      await database.events.append({
        id: `evt_${crypto.randomUUID()}`,
        runId: run.id,
        conversationId: run.conversationId,
        type: "agent.approval.required",
        payload: {
          runId: run.id,
          approvalId: approval.id,
          title: approval.title,
          riskLevel: approval.risk,
          recovered: true,
        },
        createdAt: now,
      });
      snapshottedApprovals.push(approval.id);
    }
    if (approvals.length > 0) recoveredRuns.push(run.id);
  }

  if (
    recoveredRuns.length > 0 ||
    interruptedRuns.length > 0 ||
    failedRuns.length > 0 ||
    snapshottedApprovals.length > 0
  ) {
    await database.audit.create({
      runId: undefined,
      actor: "daemon",
      action: "daemon.recovery_scan",
      target: "agent-runtime",
      payload: {
        recoveredRuns,
        interruptedRuns,
        failedRuns,
        snapshottedApprovals,
      },
      createdAt: now,
    });
  }

  return { recoveredRuns, interruptedRuns, failedRuns, snapshottedApprovals };
}

async function interruptRecoveredRun(
  database: DatabaseContext,
  run: RunRecord,
  now: string,
): Promise<void> {
  const error = {
    code: "AGENT_RUN_INTERRUPTED",
    message: "Daemon restarted while the run was unfinished.",
    category: "run_state",
    retryable: true,
  };
  await database.runs.updateStatus(run.id, "interrupted", undefined, error);
  await database.runStatusHistory.append({
    runId: run.id,
    previousStatus: run.status,
    nextStatus: "interrupted",
    reason: "daemon restarted while run was unfinished",
    actor: "daemon",
    createdAt: now,
  });
  for (const step of await database.steps.listByRunId(run.id)) {
    if (["pending", "running", "waiting_approval"].includes(step.status)) {
      await database.steps.updateStatus(step.id, "interrupted", undefined, {
        reason: "daemon restarted while run was unfinished",
      });
    }
  }
  await database.jobs.updateStatus(run.id, "interrupted");
  await database.events.append({
    id: `evt_${crypto.randomUUID()}`,
    runId: run.id,
    conversationId: run.conversationId,
    type: "agent.run.interrupted",
    payload: { runId: run.id, error },
    createdAt: now,
  });
}

function sendJson(
  socket: WebSocket,
  payload: unknown,
  markActivity?: () => void,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
  markActivity?.();
}

function bindIdleTimeout(socket: WebSocket): () => void {
  const idleTimeoutMs = 60_000;
  let lastActivityAt = Date.now();
  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const timer = setInterval(() => {
    if (Date.now() - lastActivityAt >= idleTimeoutMs) {
      socket.close(
        4000,
        "Idle timeout: no client or server activity for 60 seconds.",
      );
      clearInterval(timer);
    }
  }, 5_000);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
  socket.once("error", () => clearInterval(timer));
  return markActivity;
}

export async function createDaemon(options: DaemonOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3737;
  const paths = ensureSunPilotHome(getSunPilotPaths());
  const config = readSunPilotConfig(paths);
  const database = options.database ?? (await createDatabaseContext());
  const shouldCloseDatabase = !options.database;
  const runtimeStore = new RepositoryRuntimeStore(database);
  await runtimeStore.recoverInterrupted();
  const approvalExpiryService = new RepositoryApprovalExpiryService(database);
  await approvalExpiryService.expireStale();
  await recoverAgentRuntimeRuns(database);
  const duckDb = new DuckDbAdapterStub(paths).initialize();
  const lanceDb = new LanceDbAdapterStub(paths).initialize();

  const workflows = new WorkflowRegistry();
  for (const record of workflows.records())
    await database.workflows.upsert(record);

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const skillRegistry = new SkillRegistry(database, [paths.skills]);
  await skillRegistry.reload();
  const skillRunner = new SkillRunner(
    {
      paths,
      getRun: (id) => runtimeStore.getRun(id),
      appendEvent: (event) => runtimeStore.appendEvent(event),
      insertArtifact: (artifact) => runtimeStore.insertArtifact(artifact),
      insertMemory: (memory) => runtimeStore.insertMemory(memory),
      audit: (record) => runtimeStore.audit(record),
    },
    skillRegistry,
    {
      timeoutMs: Number(process.env.SUNPILOT_SKILL_TIMEOUT_MS ?? 5 * 60_000),
      maxConcurrency: Number(process.env.SUNPILOT_SKILL_MAX_CONCURRENCY ?? 4),
    },
  );
  const runtime = new SunPilotRuntime(runtimeStore, workflows, [
    new SkillProvider(skillRegistry, skillRunner),
    new McpProviderStub(),
  ]);
  // Agent Loop service — the primary chat entry point.
  // Uses composition root to wire all Agent Kernel components.
  let chatAgent = options.chatAgent;
  let chatAgentInit: Promise<AgentService> | undefined;
  const getChatAgent = async (): Promise<AgentService> => {
    if (chatAgent) return chatAgent as AgentService;
    chatAgentInit ??= (async () => {
      const llmProvider = createDefaultLlmProvider();
      chatAgent = createAgentLoopService({
        database,
        skillRegistry,
        skillRunner,
        workflowRuntime: runtime,
        llmProvider,
        systemPrompt: "You are SunPilot, a concise business agent assistant.",
      });
      return chatAgent as AgentService;
    })();
    return chatAgentInit;
  };

  const app = Fastify({
    logger: { level: process.env.SUNPILOT_LOG_LEVEL ?? "info" },
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RuntimeError) {
      return reply
        .code(error.statusCode)
        .send({ error: error.code, message: error.message });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "bad_request",
        message: "Request validation failed.",
        issues: error.issues,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: "internal_error", message });
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedLocalOrigin(request.headers.origin, port)) {
      await reply.code(403).send({ error: "origin_not_allowed" });
    }
  });

  app.get("/healthz", async () => ({
    ok: true,
    product: "SunPilot",
    daemon: "alive",
  }));
  app.get("/readyz", async () => ({
    ok: true,
    database: true,
    config,
    storage: { duckDb, lanceDb },
    skills: skillRegistry.list().length,
    workflows: workflows.list().length,
  }));
  app.get("/v1/diagnostics", async () => {
    const startedAt = Date.now();
    await database.runs.list({ limit: 1 });
    const databaseLatencyMs = Date.now() - startedAt;
    const skills = skillRegistry.list();
    const [waitingApproval, ...activeRuns] = await Promise.all([
      database.runs.list({ status: "waiting_approval", limit: 200 }),
      ...AGENT_ACTIVE_STATUSES.map((status) =>
        database.runs.list({ status, limit: 200 }),
      ),
    ]);
    return {
      daemon: {
        status: "ok",
        uptimeSec: Math.floor(process.uptime()),
        pid: process.pid,
      },
      database: {
        status: "ok",
        latencyMs: databaseLatencyMs,
      },
      llm: {
        configured: Boolean(
          process.env[LLM_API_KEY_ENV] || process.env[DEEPSEEK_API_KEY_ENV],
        ),
        provider: "openai-compatible",
        model: process.env[LLM_MODEL_ENV] ?? DEFAULT_LLM_MODEL,
      },
      skills: {
        count: skills.length,
        enabled: skills.filter((skill) => skill.enabled).length,
      },
      runs: {
        active: activeRuns.reduce((sum, runs) => sum + runs.length, 0),
        waitingApproval: waitingApproval.length,
      },
      websocket: {
        connections: connectionRegistry.count(),
      },
    };
  });
  app.get("/metrics", async (_request, reply) => {
    const lines: string[] = [];
    const skills = skillRegistry.list();
    const pendingApprovals = await database.approvals.list({
      status: "pending",
      limit: 200,
    });
    const activeRuns = await Promise.all(
      AGENT_ACTIVE_STATUSES.map((status) =>
        database.runs.list({ status, limit: 200 }),
      ),
    );
    const allRuns: RunRecord[] = [];
    lines.push("# HELP sunpilot_runs_active Active Agent runs.");
    lines.push("# TYPE sunpilot_runs_active gauge");
    lines.push(
      `sunpilot_runs_active ${activeRuns.reduce((sum, runs) => sum + runs.length, 0)}`,
    );
    lines.push("# HELP sunpilot_runs_total Runs by status and mode.");
    lines.push("# TYPE sunpilot_runs_total gauge");
    for (const status of RUN_STATUSES) {
      for (const mode of RUN_MODES) {
        const runs = await database.runs.list({ status, mode, limit: 200 });
        allRuns.push(...runs);
        lines.push(
          `sunpilot_runs_total{status="${status}",mode="${mode}"} ${runs.length}`,
        );
      }
    }
    const runsById = new Map(allRuns.map((run) => [run.id, run]));
    const uniqueRuns = [...runsById.values()];
    lines.push("# HELP sunpilot_run_duration_ms Run duration in ms.");
    lines.push("# TYPE sunpilot_run_duration_ms histogram");
    for (const mode of RUN_MODES) {
      for (const status of RUN_STATUSES) {
        pushHistogram(
          lines,
          "sunpilot_run_duration_ms",
          { mode, status },
          uniqueRuns
            .filter((run) => run.mode === mode && run.status === status)
            .map((run) => Date.parse(run.updatedAt) - Date.parse(run.createdAt))
            .filter((duration) => Number.isFinite(duration) && duration >= 0),
        );
      }
    }

    const modelCalls = (
      await Promise.all(
        uniqueRuns.map((run) => database.modelCalls.listByRunId(run.id)),
      )
    ).flat();
    const modelCallGroups = new Map<
      string,
      {
        provider: string;
        model: string;
        purpose: string;
        status?: string;
        count: number;
      }
    >();
    const modelLatencyGroups = new Map<
      string,
      { provider: string; model: string; purpose: string; latencies: number[] }
    >();
    const modelTokenGroups = new Map<
      string,
      {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
      }
    >();
    for (const call of modelCalls) {
      const callKey = [
        call.provider,
        call.model,
        call.purpose,
        call.status,
      ].join("\0");
      const callGroup = modelCallGroups.get(callKey) ?? {
        provider: call.provider,
        model: call.model,
        purpose: call.purpose,
        status: call.status,
        count: 0,
      };
      callGroup.count += 1;
      modelCallGroups.set(callKey, callGroup);

      const latencyKey = [call.provider, call.model, call.purpose].join("\0");
      const latencyGroup = modelLatencyGroups.get(latencyKey) ?? {
        provider: call.provider,
        model: call.model,
        purpose: call.purpose,
        latencies: [],
      };
      if (typeof call.latencyMs === "number") {
        latencyGroup.latencies.push(call.latencyMs);
      }
      modelLatencyGroups.set(latencyKey, latencyGroup);

      const tokenKey = [call.provider, call.model].join("\0");
      const tokenGroup = modelTokenGroups.get(tokenKey) ?? {
        provider: call.provider,
        model: call.model,
        inputTokens: 0,
        outputTokens: 0,
      };
      tokenGroup.inputTokens += call.inputTokens ?? 0;
      tokenGroup.outputTokens += call.outputTokens ?? 0;
      modelTokenGroups.set(tokenKey, tokenGroup);
    }
    lines.push("# HELP sunpilot_model_calls_total Model calls by provider.");
    lines.push("# TYPE sunpilot_model_calls_total counter");
    for (const group of modelCallGroups.values()) {
      lines.push(
        `sunpilot_model_calls_total{provider="${metricLabel(group.provider)}",model="${metricLabel(group.model)}",purpose="${metricLabel(group.purpose)}",status="${metricLabel(group.status)}"} ${group.count}`,
      );
    }
    lines.push("# HELP sunpilot_model_latency_ms Model call latency in ms.");
    lines.push("# TYPE sunpilot_model_latency_ms histogram");
    for (const group of modelLatencyGroups.values()) {
      pushHistogram(
        lines,
        "sunpilot_model_latency_ms",
        {
          provider: group.provider,
          model: group.model,
          purpose: group.purpose,
        },
        group.latencies,
      );
    }
    lines.push("# HELP sunpilot_model_tokens_total Model token usage.");
    lines.push("# TYPE sunpilot_model_tokens_total counter");
    for (const group of modelTokenGroups.values()) {
      const labels = `provider="${metricLabel(group.provider)}",model="${metricLabel(group.model)}"`;
      lines.push(
        `sunpilot_model_tokens_total{${labels},type="input"} ${group.inputTokens}`,
      );
      lines.push(
        `sunpilot_model_tokens_total{${labels},type="output"} ${group.outputTokens}`,
      );
    }

    const toolCalls = (
      await Promise.all(
        uniqueRuns.map((run) => database.toolCalls.listByRunId(run.id)),
      )
    ).flat();
    const toolCallGroups = new Map<
      string,
      {
        skillId: string;
        status: string;
        riskLevel: string;
        count: number;
      }
    >();
    const toolLatencyGroups = new Map<
      string,
      {
        skillId: string;
        latencies: number[];
      }
    >();
    for (const call of toolCalls) {
      const key = [call.skillId, call.status, call.riskLevel].join("\0");
      const group = toolCallGroups.get(key) ?? {
        skillId: call.skillId,
        status: call.status,
        riskLevel: call.riskLevel,
        count: 0,
      };
      group.count += 1;
      toolCallGroups.set(key, group);
      const latencyGroup = toolLatencyGroups.get(call.skillId) ?? {
        skillId: call.skillId,
        latencies: [],
      };
      if (call.startedAt && call.completedAt) {
        const latency =
          Date.parse(call.completedAt) - Date.parse(call.startedAt);
        if (Number.isFinite(latency) && latency >= 0) {
          latencyGroup.latencies.push(latency);
        }
      }
      toolLatencyGroups.set(call.skillId, latencyGroup);
    }
    lines.push("# HELP sunpilot_tool_calls_total Tool calls by skill.");
    lines.push("# TYPE sunpilot_tool_calls_total counter");
    for (const group of toolCallGroups.values()) {
      lines.push(
        `sunpilot_tool_calls_total{skill_id="${metricLabel(group.skillId)}",status="${metricLabel(group.status)}",risk_level="${metricLabel(group.riskLevel)}"} ${group.count}`,
      );
    }
    lines.push("# HELP sunpilot_tool_latency_ms Tool call latency in ms.");
    lines.push("# TYPE sunpilot_tool_latency_ms histogram");
    for (const group of toolLatencyGroups.values()) {
      pushHistogram(
        lines,
        "sunpilot_tool_latency_ms",
        { skill_id: group.skillId },
        group.latencies,
      );
    }

    const events = (
      await Promise.all(
        uniqueRuns.map((run) => database.events.listByRunId(run.id)),
      )
    ).flat();
    const uniqueEvents = [
      ...new Map(events.map((event) => [event.id, event])).values(),
    ];
    const eventCounts = new Map<string, number>();
    for (const event of uniqueEvents) {
      eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
    }
    lines.push("# HELP sunpilot_events_persisted_total Persisted events.");
    lines.push("# TYPE sunpilot_events_persisted_total counter");
    for (const [type, count] of eventCounts) {
      lines.push(
        `sunpilot_events_persisted_total{type="${metricLabel(type)}"} ${count}`,
      );
    }
    lines.push("# HELP sunpilot_approvals_pending Pending approvals.");
    lines.push("# TYPE sunpilot_approvals_pending gauge");
    lines.push(`sunpilot_approvals_pending ${pendingApprovals.length}`);
    lines.push("# HELP sunpilot_ws_connections Open WebSocket connections.");
    lines.push("# TYPE sunpilot_ws_connections gauge");
    lines.push(`sunpilot_ws_connections ${connectionRegistry.count()}`);
    lines.push("# HELP sunpilot_ws_reconnects_total WebSocket reconnects.");
    lines.push("# TYPE sunpilot_ws_reconnects_total counter");
    lines.push("sunpilot_ws_reconnects_total 0");
    lines.push(
      "# HELP sunpilot_memory_retrieval_latency_ms Memory retrieval latency in ms.",
    );
    lines.push("# TYPE sunpilot_memory_retrieval_latency_ms histogram");
    pushHistogram(lines, "sunpilot_memory_retrieval_latency_ms", {}, []);
    lines.push("# HELP sunpilot_skills_total Installed skills.");
    lines.push("# TYPE sunpilot_skills_total gauge");
    lines.push(`sunpilot_skills_total ${skills.length}`);
    lines.push("# HELP sunpilot_skills_enabled Enabled skills.");
    lines.push("# TYPE sunpilot_skills_enabled gauge");
    lines.push(
      `sunpilot_skills_enabled ${skills.filter((skill) => skill.enabled).length}`,
    );
    return reply.type("text/plain; version=0.0.4").send(lines.join("\n"));
  });

  app.get("/v1/config", async () => readSunPilotConfig(paths));
  app.patch("/v1/config", async (request) => {
    const updated = updateSunPilotConfig(
      request.body as Parameters<typeof updateSunPilotConfig>[0],
      paths,
    );
    await runtimeStore.audit({
      actor: "local-user",
      action: "config.update",
      target: "config.json",
      payload: updated,
    });
    return updated;
  });

  app.post("/v1/runs", async (request) => {
    const body = createRunSchema.parse(request.body);
    return runtime.createRun(body.input, body.workflowId, body.mode);
  });
  app.post("/v1/chat", async (request, reply) => {
    try {
      const body = parseAgentChatRequest(request.body);
      let assistantContent = "";
      const result = await (
        await getChatAgent()
      ).handleChatCommand(
        {
          conversationId: body.conversationId,
          message: body.message,
          mode: "agent",
        },
        { source: "api" },
        {
          onDelta: (delta) => {
            assistantContent += delta.delta;
          },
        },
      );
      return {
        conversationId: result.conversationId,
        message: {
          id: result.messageId,
          conversationId: result.conversationId,
          role: "assistant",
          content: assistantContent,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof RuntimeError) {
        return reply
          .code(error.statusCode)
          .send({ error: error.code, message: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(chatHttpStatus(error)).send({
        error: chatHttpStatus(error) === 400 ? "bad_request" : "internal_error",
        message,
      });
    }
  });
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/v1/conversations",
    async (request) => {
      const limit = parsePositiveInt(request.query.limit) ?? 50;
      const conversations = await database.conversations.list({
        limit: limit + 1,
        cursor: request.query.cursor,
      });
      const items = conversations.slice(0, limit);
      const next = conversations.length > limit ? items.at(-1) : undefined;
      return {
        items,
        nextCursor: next
          ? paginationCursor({ updatedAt: next.updatedAt, id: next.id })
          : undefined,
      };
    },
  );
  app.post("/v1/conversations", async (request) =>
    database.conversations.create({
      title: conversationTitleFromBody(request.body),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      const conversation = await database.conversations.findById(
        request.params.id,
      );
      if (!conversation) return reply.code(404).send({ error: "not_found" });
      return conversation;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id/messages",
    async (request, reply) => {
      const conversation = await database.conversations.findById(
        request.params.id,
      );
      if (!conversation) return reply.code(404).send({ error: "not_found" });
      return {
        conversationId: request.params.id,
        items: await database.messages.listByConversationId(request.params.id),
      };
    },
  );
  app.get<{
    Params: { id: string };
    Querystring: { afterSequence?: string; limit?: string };
  }>("/v1/conversations/:id/events", async (request, reply) => {
    if (!database.events.listByConversationId) {
      return reply.code(501).send({ error: "not_implemented" });
    }
    const events = await database.events.listByConversationId(
      request.params.id,
      parsePositiveInt(request.query.afterSequence) ?? 0,
    );
    const limit = parsePositiveInt(request.query.limit);
    return {
      conversationId: request.params.id,
      items: limit ? events.slice(0, limit) : events,
    };
  });
  app.delete<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      const deleted = await database.conversations.delete(request.params.id);
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );
  app.get<{
    Querystring: {
      status?: string;
      mode?: string;
      conversationId?: string;
      limit?: string;
      cursor?: string;
    };
  }>("/v1/runs", async (request) => {
    const limit = parsePositiveInt(request.query.limit) ?? 50;
    const runs = await database.runs.list({
      status: parseRunStatus(request.query.status),
      mode: parseRunMode(request.query.mode),
      conversationId: request.query.conversationId,
      limit: limit + 1,
      cursor: request.query.cursor,
    });
    const items = runs.slice(0, limit);
    const next = runs.length > limit ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: next
        ? paginationCursor({ updatedAt: next.updatedAt, id: next.id })
        : undefined,
    };
  });
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id",
    async (request, reply) => {
      const run = await runtimeStore.getRun(request.params.id);
      if (!run) return reply.code(404).send({ error: "not_found" });
      return {
        ...run,
        steps: await runtimeStore.listSteps(run.id),
        events: await runtimeStore.listEvents(run.id),
        artifacts: await runtimeStore.listArtifacts(run.id),
        memory: await runtimeStore.listMemory({ runId: run.id }),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/events",
    async (request) => ({
      runId: request.params.id,
      items: await database.events.listByRunId(request.params.id),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/status-history",
    async (request) => ({
      runId: request.params.id,
      items: await database.runStatusHistory.listByRunId(request.params.id),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/tool-calls",
    async (request) => ({
      runId: request.params.id,
      items: await database.toolCalls.listByRunId(request.params.id),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/model-calls",
    async (request) => ({
      runId: request.params.id,
      items: await database.modelCalls.listByRunId(request.params.id),
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { key?: string } }>(
    "/v1/runs/:id/memory",
    async (request) =>
      runtimeStore.listMemory({
        runId: request.params.id,
        key: request.query.key,
      }),
  );
  app.post("/v1/memory", async (request, reply) => {
    const body = request.body as Partial<MemoryRecord> | undefined;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "bad_request" });
    }
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) return reply.code(400).send({ error: "key_required" });
    const now = new Date().toISOString();
    const memory = await database.memory.create({
      id: body.id ?? `memory_${crypto.randomUUID()}`,
      runId: body.runId,
      stepId: body.stepId,
      key,
      value: body.value ?? body.content ?? "",
      scope: body.scope,
      scopeId: body.scopeId,
      type: body.type,
      title: body.title,
      content: body.content,
      summary: body.summary,
      source: body.source ?? "api",
      confidence: body.confidence,
      importance: body.importance,
      metadata: body.metadata ?? {},
      createdAt: body.createdAt ?? now,
      updatedAt: body.updatedAt ?? now,
      expiresAt: body.expiresAt,
    });
    return { item: memory };
  });
  app.patch<{ Params: { id: string } }>(
    "/v1/memory/:id",
    async (request, reply) => {
      const body = request.body as Partial<MemoryRecord> | undefined;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "bad_request" });
      }
      const updated = await database.memory.update(request.params.id, {
        key: body.key,
        value: body.value,
        scope: body.scope,
        scopeId: body.scopeId,
        type: body.type,
        title: body.title,
        content: body.content,
        summary: body.summary,
        source: body.source,
        confidence: body.confidence,
        importance: body.importance,
        metadata: body.metadata,
        expiresAt: body.expiresAt,
      });
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return { item: updated };
    },
  );
  app.delete<{ Params: { id: string }; Body: { reason?: string } }>(
    "/v1/memory/:id",
    async (request) => {
      await database.memory.softDelete(
        request.params.id,
        request.body?.reason ?? "deleted via api",
      );
      return { ok: true, id: request.params.id };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/interrupt",
    async (request) => runtime.interrupt(request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/cancel",
    async (request) => {
      const agent = await getChatAgent();
      try {
        return await agent.cancelRun(request.params.id, "cancelled by user");
      } catch (error) {
        if ((error as { code?: string }).code !== "AGENT_RUN_NOT_FOUND") {
          throw error;
        }
        return runtime.cancel(request.params.id);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/retry",
    async (request) => {
      const agent = await getChatAgent();
      try {
        return await agent.retryRun(request.params.id);
      } catch (error) {
        if ((error as { code?: string }).code !== "AGENT_RUN_NOT_FOUND") {
          throw error;
        }
        return runtime.retry(request.params.id);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/resume",
    async (request, reply) => {
      const agent = await getChatAgent();
      try {
        return await agent.resumeRun(request.params.id);
      } catch (error) {
        if ((error as { code?: string }).code === "AGENT_RUN_NOT_FOUND") {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );

  app.get("/v1/workflows", async () => database.workflows.list());
  app.get<{ Params: { id: string } }>(
    "/v1/workflows/:id",
    async (request, reply) => {
      const workflow = await database.workflows.findById(request.params.id);
      return workflow ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.post("/v1/workflows/reload", async () => {
    for (const record of workflows.records())
      await database.workflows.upsert(record);
    return database.workflows.list();
  });

  app.get("/v1/skills", async () => database.skills.list());
  app.get<{ Params: { id: string } }>(
    "/v1/skills/:id",
    async (request, reply) => {
      const skill = await database.skills.findById(request.params.id);
      return skill ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.post("/v1/skills/reload", async () => skillRegistry.reload());
  app.post<{ Params: { id: string } }>(
    "/v1/skills/:id/enable",
    async (request, reply) => {
      const skill = await skillRegistry.setEnabled(request.params.id, true);
      return skill ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/skills/:id/disable",
    async (request, reply) => {
      const skill = await skillRegistry.setEnabled(request.params.id, false);
      return skill ?? reply.code(404).send({ error: "not_found" });
    },
  );

  app.get<{
    Querystring: { status?: string; runId?: string; limit?: string };
  }>("/v1/approvals", async (request) => ({
    items: await database.approvals.list({
      status: parseApprovalStatus(request.query.status),
      runId: request.query.runId,
      limit: parsePositiveInt(request.query.limit),
    }),
  }));
  app.post("/v1/approvals/expire-stale", async () => ({
    items: await approvalExpiryService.expireStale(),
  }));
  app.post<{ Params: { id: string } }>(
    "/v1/approvals/:id/approve",
    async (request) => {
      const decision = approvalDecisionSchema.parse(request.body ?? {});
      const agent = await getChatAgent();
      try {
        return await agent.approve(request.params.id, decision.actor);
      } catch (error) {
        if (!shouldFallbackToRuntimeApproval(error)) {
          throw error;
        }
        return runtime.approve(request.params.id, decision);
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/approvals/:id/reject",
    async (request) => {
      const decision = approvalDecisionSchema.parse(request.body ?? {});
      const agent = await getChatAgent();
      try {
        return await agent.reject(
          request.params.id,
          decision.actor,
          decision.reason,
        );
      } catch (error) {
        if (!shouldFallbackToRuntimeApproval(error)) {
          throw error;
        }
        return runtime.reject(request.params.id, decision);
      }
    },
  );

  app.get<{ Querystring: { runId?: string } }>(
    "/v1/artifacts",
    async (request) => runtimeStore.listArtifacts(request.query.runId),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/artifacts/:id",
    async (request, reply) => {
      const artifact = await runtimeStore.getArtifact(request.params.id);
      return artifact ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/artifacts/:id/content",
    async (request, reply) => {
      const artifact = await runtimeStore.getArtifact(request.params.id);
      if (!artifact) return reply.code(404).send({ error: "not_found" });
      if (!existsSync(artifact.path) || !statSync(artifact.path).isFile()) {
        return reply.code(404).send({ error: "artifact_content_missing" });
      }
      return reply
        .type(artifact.mimeType ?? "application/octet-stream")
        .send(createReadStream(artifact.path));
    },
  );

  app.get<{ Querystring: { runId?: string; limit?: string } }>(
    "/v1/audit-logs",
    async (request) => {
      const items = await database.audit.list(request.query.runId);
      const limit = parsePositiveInt(request.query.limit);
      return limit ? items.slice(0, limit) : items;
    },
  );
  app.get("/v1/jobs", async () => runtimeStore.listJobs());
  app.post("/v1/jobs/expire-timeouts", async () => ({
    expiredRunIds: await runtimeStore.expireTimedOutJobs(),
  }));
  app.get("/v1/capabilities", async () => runtime.listCapabilities());
  app.get<{
    Querystring: {
      query?: string;
      runId?: string;
      key?: string;
      userId?: string;
      projectId?: string;
      conversationId?: string;
      scope?: string;
      type?: string;
      includeDeleted?: string;
      limit?: string;
    };
  }>("/v1/memory", async (request) => ({
    items: await database.memory.search({
      query: request.query.query,
      runId: request.query.runId,
      key: request.query.key,
      userId: request.query.userId,
      projectId: request.query.projectId,
      conversationId: request.query.conversationId,
      scopes: request.query.scope ? [request.query.scope as any] : undefined,
      types: request.query.type ? [request.query.type as any] : undefined,
      includeDeleted: request.query.includeDeleted === "true",
      limit: parsePositiveInt(request.query.limit),
    }),
  }));

  const workspaceWebDist = join(repoRoot, "packages", "web", "dist");
  const packagedWebDist = join(
    dirname(require.resolve("@sunpilot/web/package.json")),
    "dist",
  );
  const webDist = existsSync(workspaceWebDist)
    ? workspaceWebDist
    : packagedWebDist;
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  } else {
    app.get("/", async () => ({
      product: "SunPilot",
      web: "Build packages/web to serve the local web product from the daemon.",
    }));
  }

  const wsServer = new WebSocketServer({ noServer: true });
  const connectionRegistry = new ConnectionRegistry<WebSocket>(WebSocket.OPEN);
  const jsonRpcRouter = new JsonRpcRouter({
    getChatAgent,
    database,
    runtime,
    runtimeStore,
  });
  const unsubscribeEvents = subscribeEventStreamer({
    runtimeStore,
    registry: connectionRegistry,
    send: (socket, notification) => sendJson(socket, notification),
  });
  wsServer.on("connection", (socket, request) => {
    const connection = connectionRegistry.add(socket);
    const markActivity = bindIdleTimeout(socket);
    const notify = (notification: unknown) =>
      sendJson(socket, notification, markActivity);
    socket.once("close", () => {
      connectionRegistry.remove(socket);
    });
    socket.on("message", async (raw) => {
      markActivity();
      let message: { id?: string; method?: string; params?: any } = {};
      try {
        message = JSON.parse(String(raw)) as typeof message;
        const response = await jsonRpcRouter.handle(message, {
          source: "web",
          connectionId: connection.id,
          runSubscriptions: connection.runSubscriptions,
          conversationSubscriptions: connection.conversationSubscriptions,
          notify,
        });
        if (response.error) {
          sendJson(
            socket,
            { jsonrpc: "2.0", id: message.id, error: response.error },
            markActivity,
          );
          return;
        }
        sendJson(
          socket,
          { jsonrpc: "2.0", id: message.id, result: response.result },
          markActivity,
        );
      } catch (error) {
        if (message.method === "chat.send") {
          sendJson(
            socket,
            agentErrorNotification(
              error,
              typeof message.params?.conversationId === "string"
                ? message.params.conversationId
                : undefined,
            ),
            markActivity,
          );
        }
        sendJson(
          socket,
          { jsonrpc: "2.0", id: message.id, error: rpcError(error) },
          markActivity,
        );
      }
    });
  });

  return {
    app,
    paths,
    async start() {
      await app.listen({ host, port });
      writeFileSync(paths.pidFile, String(process.pid), { mode: 0o600 });
      const server = app.server;
      server.on("upgrade", (request, socket, head) => {
        if (!request.url?.startsWith("/v1/ws")) return;
        if (!isAllowedLocalOrigin(request.headers.origin, port)) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        wsServer.handleUpgrade(request, socket, head, (websocket) =>
          wsServer.emit("connection", websocket, request),
        );
      });
      appendFileSync(
        paths.logs + "/daemon.log",
        JSON.stringify({
          level: "info",
          message: "SunPilot daemon started",
          host,
          port,
          createdAt: new Date().toISOString(),
        }) + "\n",
      );
      await runtimeStore.audit({
        actor: "daemon",
        action: "daemon.start",
        target: `${host}:${port}`,
        payload: { host, port },
      });
      app.log.info({ host, port }, "SunPilot daemon started");
    },
    async stop() {
      await runtimeStore.audit({
        actor: "daemon",
        action: "daemon.stop",
        target: `${host}:${port}`,
        payload: { host, port },
      });
      unsubscribeEvents();
      connectionRegistry.clear();
      wsServer.close();
      await app.close();
      if (shouldCloseDatabase) await database.close();
    },
  };
}
