import type { FastifyInstance } from "fastify";
import type { RunMode, RunRecord, RunStatus } from "@sunpilot/protocol";
import {
  DEFAULT_LLM_MODEL,
  DEEPSEEK_API_KEY_ENV,
  LLM_API_KEY_ENV,
  LLM_MODEL_ENV,
} from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";

const AGENT_ACTIVE_STATUSES: RunStatus[] = [
  "created",
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "executing",
  "observing",
  "reflecting",
  "responding",
];

const RUN_STATUSES: RunStatus[] = [
  "created",
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "waiting_approval",
  "executing",
  "observing",
  "reflecting",
  "responding",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
];

const RUN_MODES: RunMode[] = ["chat", "agent"];
const METRIC_BUCKETS_MS = [100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

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

interface SkillSummarySource {
  list(): Array<{ enabled: boolean }>;
}

interface ConnectionCounter {
  count(): number;
}

export function registerDaemonMetricsRoutes(
  app: FastifyInstance,
  deps: {
    database: DatabaseContext;
    skillRegistry: SkillSummarySource;
    connectionRegistry: ConnectionCounter;
  },
): void {
  const {
    database,
    skillRegistry,
    connectionRegistry,
  } = deps;

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
}
