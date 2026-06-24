import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import {
  AgentService,
  createDefaultLlmProvider,
  InMemoryAgentEventBus,
  RepositoryApprovalExpiryService,
  RuntimeError,
  SummaryStaleDetector,
  type AgentEventBus,
} from "@sunpilot/core";
import { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";
import {
  createDatabaseContext,
  type DatabaseContext,
  ensureSunPilotHome,
  getSunPilotPaths,
} from "@sunpilot/storage";
import { createPlatformServices } from "@sunpilot/platform";
import { createAgentLoopService } from "./composition-root.js";
import {
  registerSunPilotApiRoutes,
  createOssClient,
  type SunPilotApiDeps,
} from "@sunpilot/api";
import { registerDaemonMetricsRoutes } from "./metrics.js";
import { recoverAgentRuntimeRuns } from "./recovery.js";
import { setupDaemonWebSocket } from "./ws.js";
import { readSunPilotConfig, updateSunPilotConfig } from "@sunpilot/storage";
import { AuditActor } from "@sunpilot/protocol";
import { StaleDetectionWorker } from "./stale-detection-worker.js";
import { MemoryPruningWorker } from "./memory-pruning-worker.js";

export interface DaemonOptions {
  port?: number;
  host?: string;
  chatAgent?: Pick<
    AgentService,
    | "handleChatCommand"
    | "startChatCommand"
    | "stopChat"
    | "cancelRun"
    | "resumeRun"
    | "retryRun"
    | "approve"
    | "reject"
  >;
  database?: DatabaseContext;
  eventBus?: AgentEventBus;
}

const DEFAULT_EXTERNAL_ORIGINS = [
  "https://tradeagent.asia",
  "https://www.tradeagent.asia",
];
const require = createRequire(import.meta.url);

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

export async function createDaemon(options: DaemonOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3737;
  const paths = ensureSunPilotHome(getSunPilotPaths());
  const database = options.database ?? (await createDatabaseContext());
  const shouldCloseDatabase = !options.database;

  const eventBus = options.eventBus ?? new InMemoryAgentEventBus();

  const approvalExpiryService = new RepositoryApprovalExpiryService(database);
  await approvalExpiryService.expireStale();
  await recoverAgentRuntimeRuns(database);

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const skillRegistry = new SkillRegistry(database, [paths.skills]);
  await skillRegistry.reload();
  const skillRunner = new SkillRunner(
    {
      paths,
      getRun: async (id) => (await database.runs.findById(id)) ?? undefined,
      appendEvent: async (event) => {
        await database.events.append(event);
      },
      insertArtifact: async (artifact) => {
        await database.artifacts.create(artifact);
      },
      insertMemory: async (memory) => {
        await database.memory.create(memory);
      },
      audit: async (record) => {
        await database.audit.create({
          ...record,
          createdAt: new Date().toISOString(),
        });
      },
    },
    skillRegistry,
    {
      timeoutMs: Number(process.env.SUNPILOT_SKILL_TIMEOUT_MS ?? 5 * 60_000),
      maxConcurrency: Number(process.env.SUNPILOT_SKILL_MAX_CONCURRENCY ?? 4),
    },
  );

  let chatAgent = options.chatAgent;
  const liveEventBus = new InMemoryAgentEventBus();
  let chatAgentInit: Promise<AgentService> | undefined;
  let modelRouterRef: { getStats(): { persistFailures: number; totalCalls: number; fallbackCount: number } } | undefined;
  let _updateMemory: ((id: string, input: { content?: string; title?: string; summary?: string; confidence?: number; importance?: number }) => Promise<{ id: string } | null>) | undefined;
  const getChatAgent = async (): Promise<AgentService> => {
    if (chatAgent) return chatAgent as AgentService;
    chatAgentInit ??= (async () => {
      const llmProvider = createDefaultLlmProvider();
      const { service, modelRouter, updateMemory } = createAgentLoopService({
        database,
        skillRegistry,
        skillRunner,
        llmProvider,
        eventBus,
        liveEventBus,
        systemPrompt: "You are SunPilot, a concise business agent assistant.",
      });
      chatAgent = service;
      modelRouterRef = modelRouter;
      _updateMemory = updateMemory;
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

  const platform = createPlatformServices({ database, getAgent: getChatAgent });
  const apiDeps: SunPilotApiDeps = {
    database,
    platform,
    paths,
    getChatAgent,
    skills: {
      reload: async () => skillRegistry.reload(),
      list: () => skillRegistry.list(),
      setEnabled: async (id: string, enabled: boolean) =>
        skillRegistry.setEnabled(id, enabled),
    },
    config: {
      read: () => readSunPilotConfig(paths),
      update: (input: unknown) =>
        updateSunPilotConfig(
          input as Parameters<typeof updateSunPilotConfig>[0],
          paths,
        ),
    },
    oss: createOssClient() ?? undefined,
    diagnostics: {
      websocketConnections: () => 0, // updated below after ws setup
      getLlmConfig: () => ({
        configured: Boolean(
          process.env["SUNPILOT_LLM_API_KEY"] || process.env["SUNPILOT_DP_LLM_API_KEY"],
        ),
        provider: "openai-compatible",
        model: process.env["SUNPILOT_LLM_MODEL"] ?? process.env["SUNPILOT_DP_LLM_MODEL"] ?? "deepseek-v4-flash",
      }),
      getModelRouterStats: () => {
        if (!modelRouterRef) return { persistFailures: 0, totalCalls: 0, fallbackCount: 0 };
        const stats = modelRouterRef.getStats();
        return {
          persistFailures: stats.persistFailures,
          totalCalls: stats.totalCalls,
          fallbackCount: stats.fallbackCount,
        };
      },
    },
    getModels: () => {
      const hasSeed = !!(
        process.env["SUNPILOT_SEED_LLM_API_KEY"]
      );
      const dpModel = process.env["SUNPILOT_DP_LLM_MODEL"] ?? process.env["SUNPILOT_LLM_MODEL"] ?? "deepseek-v4-flash";
      const seedModel = process.env["SUNPILOT_SEED_LLM_MODEL"] ?? "doubao-seed-2-0-lite-260428";
      return [
        { id: "dp", label: "Deepseek-v4-flash", provider: "deepseek", model: dpModel, available: true },
        { id: "seed", label: "Seed-2.0-lite", provider: "volcengine-ark", model: seedModel, available: hasSeed },
      ];
    },
    updateMemory: async (id, input) => {
      if (!_updateMemory) {
        // Agent loop not yet initialized — fall back to direct update
        return database.memory.update(id, input as Parameters<typeof database.memory.update>[1]);
      }
      return _updateMemory(id, input);
    },
  };
  registerSunPilotApiRoutes(app, apiDeps);

  // Subscribe to Agent Run events and forward to TaskExecutor
  // so that work_on actions complete when the Agent Run finishes.
  const PLATFORM_CTX = { actorType: "service" as const, clientType: "api" as const };
  liveEventBus.subscribe(async (event) => {
    if (
      event.type === "agent.run.completed" ||
      event.type === "agent.run.failed" ||
      event.type === "agent.run.cancelled"
    ) {
      const runId = event.runId;
      if (!runId) return;

      const runStatus =
        event.type === "agent.run.completed" ? "completed" :
        event.type === "agent.run.failed" ? "failed" : "cancelled";

      // Collect artifacts from the run if completed
      const artifacts: Array<{ type: string; title: string; uri?: string }> = [];
      if (runStatus === "completed" && event.payload) {
        const payload = event.payload as Record<string, unknown>;
        if (Array.isArray(payload["artifacts"])) {
          for (const a of payload["artifacts"] as Array<Record<string, unknown>>) {
            artifacts.push({
              type: (a["type"] as string) ?? "unknown",
              title: (a["title"] as string) ?? (a["name"] as string) ?? "产物",
              uri: a["uri"] as string | undefined,
            });
          }
        }
      }

      try {
        await platform.executor.onAgentRunCompleted(PLATFORM_CTX, runId, runStatus, artifacts);
      } catch (err) {
        app.log.warn({ err, runId }, "Failed to handle agent run completion in TaskExecutor");
      }
    }
  });

  const ws = setupDaemonWebSocket({
    getChatAgent,
    database,
    eventSubscribe: (listener) => {
      return liveEventBus.subscribe((agentEvent) => {
        listener(agentEvent);
      });
    },
    port,
    isAllowedOrigin: isAllowedLocalOrigin,
  });

  // Update diagnostics with real websocket count after ws is set up
  if (apiDeps.diagnostics) {
    apiDeps.diagnostics.websocketConnections = () => ws.connectionRegistry.count();
  }

  registerDaemonMetricsRoutes(app, {
    database,
    skillRegistry,
    connectionRegistry: ws.connectionRegistry,
  });

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

  // ── Background workers ──────────────────────────────────────────
  const staleDetectionWorker = new StaleDetectionWorker({
    database,
    staleDetector: new SummaryStaleDetector(),
    intervalMs: 300_000, // 5 min
  });
  const pruningWorker = new MemoryPruningWorker({
    database,
    intervalMs: 3_600_000, // 1 hour
  });

  return {
    app,
    paths,
    async start() {
      await app.listen({ host, port });
      writeFileSync(paths.pidFile, String(process.pid), { mode: 0o600 });
      ws.attach(app.server);

      // Start background workers
      staleDetectionWorker.start();
      pruningWorker.start();

      // Seed default world nodes/edges if database is empty
      try {
        await platform.world.seedDefaultWorld({ actorType: "service", clientType: "api" });
        app.log.info("Default world seed completed");
      } catch (err) {
        app.log.warn({ err }, "Default world seed failed (may already exist)");
      }

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
      await database.audit.create({
        actor: AuditActor.Daemon,
        action: "daemon.start",
        target: `${host}:${port}`,
        payload: { host, port },
        createdAt: new Date().toISOString(),
      });
      app.log.info({ host, port }, "SunPilot daemon started");
    },
    async stop() {
      staleDetectionWorker.stop();
      pruningWorker.stop();

      await database.audit.create({
        actor: AuditActor.Daemon,
        action: "daemon.stop",
        target: `${host}:${port}`,
        payload: { host, port },
        createdAt: new Date().toISOString(),
      });
      ws.dispose();
      await app.close();
      if (shouldCloseDatabase) await database.close();
    },
  };
}
