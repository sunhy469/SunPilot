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
  McpProviderStub,
  RepositoryApprovalExpiryService,
  RepositoryRuntimeStore,
  RuntimeError,
  SkillProvider,
  SunPilotRuntime,
} from "@sunpilot/core";
import { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";
import {
  createDatabaseContext,
  type DatabaseContext,
  DuckDbAdapterStub,
  ensureSunPilotHome,
  getSunPilotPaths,
  LanceDbAdapterStub,
} from "@sunpilot/storage";
import { WorkflowRegistry } from "@sunpilot/workflow";
import { createAgentLoopService } from "./composition-root.js";
import { registerDaemonMetricsRoutes } from "./metrics.js";
import { recoverAgentRuntimeRuns } from "./recovery.js";
import { registerDaemonRoutes } from "./routes.js";
import { setupDaemonWebSocket } from "./ws.js";

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
  const runtimeStore = new RepositoryRuntimeStore(database);
  await runtimeStore.recoverInterrupted();
  const approvalExpiryService = new RepositoryApprovalExpiryService(database);
  await approvalExpiryService.expireStale();
  await recoverAgentRuntimeRuns(database);
  const duckDb = new DuckDbAdapterStub(paths).initialize();
  const lanceDb = new LanceDbAdapterStub(paths).initialize();

  const workflows = new WorkflowRegistry();
  for (const record of workflows.records()) {
    await database.workflows.upsert(record);
  }

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

  registerDaemonRoutes(app, {
    database,
    paths,
    duckDb,
    lanceDb,
    runtime,
    runtimeStore,
    approvalExpiryService,
    workflows,
    skillRegistry,
    getChatAgent,
  });

  const ws = setupDaemonWebSocket({
    getChatAgent,
    database,
    runtimeStore,
    port,
    isAllowedOrigin: isAllowedLocalOrigin,
  });

  registerDaemonMetricsRoutes(app, {
    database,
    skillRegistry,
    workflows,
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

  return {
    app,
    paths,
    async start() {
      await app.listen({ host, port });
      writeFileSync(paths.pidFile, String(process.pid), { mode: 0o600 });
      ws.attach(app.server);
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
      ws.dispose();
      await app.close();
      if (shouldCloseDatabase) await database.close();
    },
  };
}
