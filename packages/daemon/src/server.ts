import { appendFileSync, createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";
import { approvalDecisionSchema, createRunSchema } from "@sunpilot/protocol";
import { AgentService, createDefaultLlmProvider, McpProviderStub, RepositoryAgentConversationStore, RepositoryRuntimeStore, RuntimeError, SkillProvider, SunPilotRuntime } from "@sunpilot/core";
import { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";
import { createDatabaseContext, type DatabaseContext, DuckDbAdapterStub, ensureSunPilotHome, getSunPilotPaths, LanceDbAdapterStub, readSunPilotConfig, updateSunPilotConfig } from "@sunpilot/storage";
import { fixtureApprovalWorkflow, fixtureEchoWorkflow, fixtureFilePermissionWorkflow, fixtureShellPermissionWorkflow, WorkflowRegistry } from "@sunpilot/workflow";

export interface DaemonOptions {
  port?: number;
  host?: string;
  chatAgent?: Pick<AgentService, "chat">;
  database?: DatabaseContext;
}

const require = createRequire(import.meta.url);
const DEFAULT_EXTERNAL_ORIGINS = ["https://tradeagent.asia", "https://www.tradeagent.asia"];

function allowedExternalOrigins(): Set<string> {
  return new Set(
    [DEFAULT_EXTERNAL_ORIGINS.join(","), process.env.SUNPILOT_ALLOWED_ORIGINS ?? ""]
      .join(",")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
}

function isAllowedLocalOrigin(origin: string | undefined, port: number, externalOrigins = allowedExternalOrigins()): boolean {
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

function rpcError(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RuntimeError) {
    return { code: error.statusCode === 404 ? -32004 : error.statusCode === 409 ? -32009 : -32000, message: error.message };
  }
  if (error instanceof ZodError) {
    return { code: -32602, message: "Invalid params", data: error.issues };
  }
  return { code: -32000, message: error instanceof Error ? error.message : String(error) };
}

function chatHttpStatus(error: unknown): number {
  if (error instanceof RuntimeError) return error.statusCode;
  if (error instanceof Error && (error.message.includes("request must be an object") || error.message.includes("message is required") || error.message.includes("conversationId must be"))) {
    return 400;
  }
  return 500;
}

function conversationTitleFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const title = (body as { title?: unknown }).title;
  if (title === undefined) return undefined;
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("title must be a non-empty string when provided.");
  }
  return title.trim();
}

function sendJson(socket: WebSocket, payload: unknown, markActivity?: () => void): void {
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
      socket.close(4000, "Idle timeout: no client or server activity for 60 seconds.");
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
  const database = options.database ?? await createDatabaseContext();
  const shouldCloseDatabase = !options.database;
  const runtimeStore = new RepositoryRuntimeStore(database);
  await runtimeStore.recoverInterrupted();
  const duckDb = new DuckDbAdapterStub(paths).initialize();
  const lanceDb = new LanceDbAdapterStub(paths).initialize();

  const workflows = new WorkflowRegistry();
  workflows.register(fixtureEchoWorkflow);
  workflows.register(fixtureApprovalWorkflow);
  workflows.register(fixtureShellPermissionWorkflow);
  workflows.register(fixtureFilePermissionWorkflow);
  for (const record of workflows.records()) await database.workflows.upsert(record);

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const workspaceFixtureSkillRoot = join(repoRoot, "packages", "skills", "fixtures");
  const packagedFixtureSkillRoot = resolve(dirname(require.resolve("@sunpilot/fixture-echo-skill")), "..");
  const fixtureSkillDirs = existsSync(workspaceFixtureSkillRoot)
    ? [workspaceFixtureSkillRoot, packagedFixtureSkillRoot]
    : [packagedFixtureSkillRoot];
  const skillRegistry = new SkillRegistry(database, [paths.skills], fixtureSkillDirs);
  await skillRegistry.reload();
  const skillRunner = new SkillRunner({
    paths,
    getRun: (id) => runtimeStore.getRun(id),
    appendEvent: (event) => runtimeStore.appendEvent(event),
    insertArtifact: (artifact) => runtimeStore.insertArtifact(artifact),
    insertMemory: (memory) => runtimeStore.insertMemory(memory),
    audit: (record) => runtimeStore.audit(record)
  }, skillRegistry, {
    timeoutMs: Number(process.env.SUNPILOT_SKILL_TIMEOUT_MS ?? 5 * 60_000),
    maxConcurrency: Number(process.env.SUNPILOT_SKILL_MAX_CONCURRENCY ?? 4)
  });
  const runtime = new SunPilotRuntime(runtimeStore, workflows, [
    new SkillProvider(skillRegistry, skillRunner),
    new McpProviderStub()
  ]);
  let chatAgent = options.chatAgent;
  let chatAgentInit: Promise<Pick<AgentService, "chat">> | undefined;
  const getChatAgent = async () => {
    if (chatAgent) return chatAgent;
    chatAgentInit ??= (async () => {
      chatAgent = new AgentService({
        llm: createDefaultLlmProvider(),
        conversations: new RepositoryAgentConversationStore(database),
        systemPrompt: "You are SunPilot, a concise business agent assistant."
      });
      return chatAgent;
    })();
    return chatAgentInit;
  };

  const app = Fastify({ logger: { level: process.env.SUNPILOT_LOG_LEVEL ?? "info" } });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RuntimeError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "bad_request", message: "Request validation failed.", issues: error.issues });
    }
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(500).send({ error: "internal_error", message });
  });
  app.addHook("onRequest", async (request, reply) => {
    if (!isAllowedLocalOrigin(request.headers.origin, port)) {
      await reply.code(403).send({ error: "origin_not_allowed" });
    }
  });

  app.get("/healthz", async () => ({ ok: true, product: "SunPilot", daemon: "alive" }));
  app.get("/readyz", async () => ({
    ok: true,
    database: true,
    config,
    storage: { duckDb, lanceDb },
    skills: skillRegistry.list().length,
    workflows: workflows.list().length
  }));

  app.get("/v1/config", async () => readSunPilotConfig(paths));
  app.patch("/v1/config", async (request) => {
    const updated = updateSunPilotConfig(request.body as Parameters<typeof updateSunPilotConfig>[0], paths);
    await runtimeStore.audit({ actor: "local-user", action: "config.update", target: "config.json", payload: updated });
    return updated;
  });

  app.post("/v1/runs", async (request) => {
    const body = createRunSchema.parse(request.body);
    return runtime.createRun(body.input, body.workflowId, body.mode);
  });
  app.post("/v1/chat", async (request, reply) => {
    try {
      return await (await getChatAgent()).chat(request.body);
    } catch (error) {
      if (error instanceof RuntimeError) {
        return reply.code(error.statusCode).send({ error: error.code, message: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(chatHttpStatus(error)).send({ error: chatHttpStatus(error) === 400 ? "bad_request" : "internal_error", message });
    }
  });
  app.get<{ Querystring: { limit?: string } }>("/v1/conversations", async (request) => ({
    items: await database.conversations.list({
      limit: request.query.limit ? Number(request.query.limit) : undefined
    })
  }));
  app.post("/v1/conversations", async (request) => database.conversations.create({ title: conversationTitleFromBody(request.body) }));
  app.get<{ Params: { id: string } }>("/v1/conversations/:id/messages", async (request, reply) => {
    const conversation = await database.conversations.findById(request.params.id);
    if (!conversation) return reply.code(404).send({ error: "not_found" });
    return { conversationId: request.params.id, items: await database.messages.listByConversationId(request.params.id) };
  });
  app.delete<{ Params: { id: string } }>("/v1/conversations/:id", async (request, reply) => {
    const deleted = await database.conversations.delete(request.params.id);
    if (!deleted) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });
  app.get("/v1/runs", async () => runtimeStore.listRuns());
  app.get<{ Params: { id: string } }>("/v1/runs/:id", async (request, reply) => {
    const run = await runtimeStore.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return {
      ...run,
      steps: await runtimeStore.listSteps(run.id),
      events: await runtimeStore.listEvents(run.id),
      artifacts: await runtimeStore.listArtifacts(run.id),
      memory: await runtimeStore.listMemory({ runId: run.id })
    };
  });
  app.get<{ Params: { id: string } }>("/v1/runs/:id/events", async (request) => runtimeStore.listEvents(request.params.id));
  app.get<{ Params: { id: string }; Querystring: { key?: string } }>("/v1/runs/:id/memory", async (request) => runtimeStore.listMemory({ runId: request.params.id, key: request.query.key }));
  app.post<{ Params: { id: string } }>("/v1/runs/:id/interrupt", async (request) => runtime.interrupt(request.params.id));
  app.post<{ Params: { id: string } }>("/v1/runs/:id/cancel", async (request) => runtime.cancel(request.params.id));
  app.post<{ Params: { id: string } }>("/v1/runs/:id/retry", async (request) => runtime.retry(request.params.id));

  app.get("/v1/workflows", async () => database.workflows.list());
  app.get<{ Params: { id: string } }>("/v1/workflows/:id", async (request, reply) => {
    const workflow = await database.workflows.findById(request.params.id);
    return workflow ?? reply.code(404).send({ error: "not_found" });
  });
  app.post("/v1/workflows/reload", async () => {
    for (const record of workflows.records()) await database.workflows.upsert(record);
    return database.workflows.list();
  });

  app.get("/v1/skills", async () => database.skills.list());
  app.get<{ Params: { id: string } }>("/v1/skills/:id", async (request, reply) => {
    const skill = await database.skills.findById(request.params.id);
    return skill ?? reply.code(404).send({ error: "not_found" });
  });
  app.post("/v1/skills/reload", async () => skillRegistry.reload());
  app.post<{ Params: { id: string } }>("/v1/skills/:id/enable", async (request, reply) => {
    const skill = await skillRegistry.setEnabled(request.params.id, true);
    return skill ?? reply.code(404).send({ error: "not_found" });
  });
  app.post<{ Params: { id: string } }>("/v1/skills/:id/disable", async (request, reply) => {
    const skill = await skillRegistry.setEnabled(request.params.id, false);
    return skill ?? reply.code(404).send({ error: "not_found" });
  });

  app.get("/v1/approvals", async () => runtimeStore.listApprovals());
  app.post<{ Params: { id: string } }>("/v1/approvals/:id/approve", async (request) => runtime.approve(request.params.id, approvalDecisionSchema.parse(request.body ?? {})));
  app.post<{ Params: { id: string } }>("/v1/approvals/:id/reject", async (request) => runtime.reject(request.params.id, approvalDecisionSchema.parse(request.body ?? {})));

  app.get("/v1/artifacts", async () => runtimeStore.listArtifacts());
  app.get<{ Params: { id: string } }>("/v1/artifacts/:id", async (request, reply) => {
    const artifact = await runtimeStore.getArtifact(request.params.id);
    return artifact ?? reply.code(404).send({ error: "not_found" });
  });
  app.get<{ Params: { id: string } }>("/v1/artifacts/:id/content", async (request, reply) => {
    const artifact = await runtimeStore.getArtifact(request.params.id);
    if (!artifact) return reply.code(404).send({ error: "not_found" });
    if (!existsSync(artifact.path) || !statSync(artifact.path).isFile()) {
      return reply.code(404).send({ error: "artifact_content_missing" });
    }
    return reply.type(artifact.mimeType ?? "application/octet-stream").send(createReadStream(artifact.path));
  });

  app.get<{ Querystring: { runId?: string } }>("/v1/audit-logs", async (request) => database.audit.list(request.query.runId));
  app.get("/v1/jobs", async () => runtimeStore.listJobs());
  app.post("/v1/jobs/expire-timeouts", async () => ({ expiredRunIds: await runtimeStore.expireTimedOutJobs() }));
  app.get("/v1/capabilities", async () => runtime.listCapabilities());
  app.get<{ Querystring: { runId?: string; key?: string } }>("/v1/memory", async (request) => runtimeStore.listMemory({ runId: request.query.runId, key: request.query.key }));

  const workspaceWebDist = join(repoRoot, "packages", "web", "dist");
  const packagedWebDist = join(dirname(require.resolve("@sunpilot/web/package.json")), "dist");
  const webDist = existsSync(workspaceWebDist) ? workspaceWebDist : packagedWebDist;
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  } else {
    app.get("/", async () => ({
      product: "SunPilot",
      web: "Build packages/web to serve the local web product from the daemon."
    }));
  }

  const wsServer = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const unsubscribeEvents = runtimeStore.subscribeEvents((event) => {
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "run.event", params: { runId: event.runId, event } });
    for (const [socket, runIds] of subscriptions) {
      if (socket.readyState === WebSocket.OPEN && (runIds.has(event.runId) || runIds.has("*"))) {
        sendJson(socket, JSON.parse(notification));
      }
    }
  });
  wsServer.on("connection", (socket, request) => {
    subscriptions.set(socket, new Set());
    const markActivity = bindIdleTimeout(socket);
    socket.once("close", () => subscriptions.delete(socket));
    socket.on("message", async (raw) => {
      markActivity();
      let message: { id?: string; method?: string; params?: any } = {};
      try {
        message = JSON.parse(String(raw)) as typeof message;
        if (message.method === "run.create") {
          const body = createRunSchema.parse(message.params ?? {});
          const run = await runtime.createRun(body.input, body.workflowId, body.mode);
          sendJson(socket, { jsonrpc: "2.0", id: message.id, result: run }, markActivity);
          return;
        }
        if (message.method === "chat.send") {
          const result = await (await getChatAgent()).chat(message.params ?? {}, {
            onUserMessage: (created) => sendJson(socket, { jsonrpc: "2.0", method: "chat.message.created", params: { conversationId: created.conversationId, message: created } }, markActivity),
            onAssistantStarted: (started) => sendJson(socket, { jsonrpc: "2.0", method: "chat.assistant.started", params: started }, markActivity),
            onAssistantDelta: (delta) => sendJson(socket, { jsonrpc: "2.0", method: "chat.assistant.delta", params: delta }, markActivity),
            onAssistantMessage: (created) => sendJson(socket, { jsonrpc: "2.0", method: "chat.assistant.completed", params: { conversationId: created.conversationId, message: created } }, markActivity)
          });
          sendJson(socket, { jsonrpc: "2.0", id: message.id, result }, markActivity);
          return;
        }
        if (message.method === "ping") {
          sendJson(socket, { jsonrpc: "2.0", id: message.id, result: { ok: true } }, markActivity);
          sendJson(socket, { jsonrpc: "2.0", method: "pong", params: {} }, markActivity);
          return;
        }
        if (message.method === "conversation.subscribe" || message.method === "conversation.unsubscribe") {
          sendJson(socket, { jsonrpc: "2.0", id: message.id, result: { conversationId: message.params?.conversationId, subscribed: message.method === "conversation.subscribe" } }, markActivity);
          return;
        }
        if (message.method === "chat.stop") {
          sendJson(socket, { jsonrpc: "2.0", id: message.id, result: { stopped: true } }, markActivity);
          return;
        }
        if (message.method === "run.subscribe") {
          const runId = typeof message.params?.runId === "string" ? message.params.runId : "*";
          subscriptions.get(socket)?.add(runId);
          const events = runId === "*" ? [] : await runtimeStore.listEvents(runId);
          sendJson(socket, { jsonrpc: "2.0", id: message.id, result: { runId, events } }, markActivity);
          return;
        }
        if (message.method === "run.unsubscribe") {
          const runId = typeof message.params?.runId === "string" ? message.params.runId : "*";
          subscriptions.get(socket)?.delete(runId);
          sendJson(socket, { jsonrpc: "2.0", id: message.id, result: { runId, subscribed: false } }, markActivity);
          return;
        }
        sendJson(socket, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }, markActivity);
      } catch (error) {
        if (message.method === "chat.send") {
          sendJson(
            socket,
            {
              jsonrpc: "2.0",
              method: "chat.error",
              params: {
                conversationId: typeof message.params?.conversationId === "string" ? message.params.conversationId : undefined,
                error: rpcError(error)
              }
            },
            markActivity
          );
        }
        sendJson(socket, { jsonrpc: "2.0", id: message.id, error: rpcError(error) }, markActivity);
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
        wsServer.handleUpgrade(request, socket, head, (websocket) => wsServer.emit("connection", websocket, request));
      });
      appendFileSync(paths.logs + "/daemon.log", JSON.stringify({ level: "info", message: "SunPilot daemon started", host, port, createdAt: new Date().toISOString() }) + "\n");
      await runtimeStore.audit({ actor: "daemon", action: "daemon.start", target: `${host}:${port}`, payload: { host, port } });
      app.log.info({ host, port }, "SunPilot daemon started");
    },
    async stop() {
      await runtimeStore.audit({ actor: "daemon", action: "daemon.stop", target: `${host}:${port}`, payload: { host, port } });
      unsubscribeEvents();
      subscriptions.clear();
      wsServer.close();
      await app.close();
      if (shouldCloseDatabase) await database.close();
    }
  };
}
