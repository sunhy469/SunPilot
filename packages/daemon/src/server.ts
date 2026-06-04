import { appendFileSync, createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { WebSocket, WebSocketServer } from "ws";
import { ZodError } from "zod";
import { approvalDecisionSchema, createRunSchema } from "@sunpilot/protocol";
import { McpProviderStub, RuntimeError, SkillProvider, SunPilotRuntime } from "@sunpilot/core";
import { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";
import { DuckDbAdapterStub, ensureLocalToken, ensureSunPilotHome, getSunPilotPaths, LanceDbAdapterStub, readSunPilotConfig, SunPilotDatabase, updateSunPilotConfig } from "@sunpilot/storage";
import { fixtureApprovalWorkflow, fixtureEchoWorkflow, fixtureFilePermissionWorkflow, fixtureShellPermissionWorkflow, WorkflowRegistry } from "@sunpilot/workflow";

export interface DaemonOptions {
  port?: number;
  host?: string;
}

const require = createRequire(import.meta.url);
const DEFAULT_EXTERNAL_ORIGINS = ["https://tradeagent.asia", "https://www.tradeagent.asia"];

function bearerToken(header: string | undefined): string | undefined {
  const [type, token] = (header ?? "").split(" ");
  return type === "Bearer" ? token : undefined;
}

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

function isPublicGetPath(url: string, host: string, port: number): boolean {
  const path = new URL(url, `http://${host}:${port}`).pathname;
  return path === "/healthz" || path === "/readyz" || path === "/" || path.startsWith("/assets/");
}

function allowsQueryToken(url: string, host: string, port: number): boolean {
  const path = new URL(url, `http://${host}:${port}`).pathname;
  return /^\/v1\/artifacts\/[^/]+\/content$/.test(path);
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

export async function createDaemon(options: DaemonOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3737;
  const paths = ensureSunPilotHome(getSunPilotPaths());
  const config = readSunPilotConfig(paths);
  const token = ensureLocalToken(paths);
  const db = new SunPilotDatabase(paths);
  db.recoverInterrupted();
  const duckDb = new DuckDbAdapterStub(paths).initialize();
  const lanceDb = new LanceDbAdapterStub(paths).initialize();

  const workflows = new WorkflowRegistry();
  workflows.register(fixtureEchoWorkflow);
  workflows.register(fixtureApprovalWorkflow);
  workflows.register(fixtureShellPermissionWorkflow);
  workflows.register(fixtureFilePermissionWorkflow);
  for (const record of workflows.records()) db.upsertWorkflow(record);

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const workspaceFixtureSkillRoot = join(repoRoot, "packages", "skills", "fixtures");
  const packagedFixtureSkillRoot = resolve(dirname(require.resolve("@sunpilot/fixture-echo-skill")), "..");
  const fixtureSkillDirs = existsSync(workspaceFixtureSkillRoot)
    ? [workspaceFixtureSkillRoot, packagedFixtureSkillRoot]
    : [packagedFixtureSkillRoot];
  const skillRegistry = new SkillRegistry(db, [paths.skills], fixtureSkillDirs);
  await skillRegistry.reload();
  const skillRunner = new SkillRunner(db, skillRegistry, {
    timeoutMs: Number(process.env.SUNPILOT_SKILL_TIMEOUT_MS ?? 5 * 60_000),
    maxConcurrency: Number(process.env.SUNPILOT_SKILL_MAX_CONCURRENCY ?? 4)
  });
  const runtime = new SunPilotRuntime(db, workflows, [
    new SkillProvider(skillRegistry, skillRunner),
    new McpProviderStub()
  ]);

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
      return;
    }
    if (request.method === "GET" && isPublicGetPath(request.url, host, port)) return;
    const queryToken = allowsQueryToken(request.url, host, port)
      ? new URL(request.url, `http://${host}:${port}`).searchParams.get("token") ?? undefined
      : undefined;
    if (bearerToken(request.headers.authorization) !== token && queryToken !== token) {
      await reply.code(401).send({ error: "missing_or_invalid_local_token" });
      return;
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
    db.audit({ actor: "local-user", action: "config.update", target: "config.json", payload: updated });
    return updated;
  });

  app.post("/v1/runs", async (request) => {
    const body = createRunSchema.parse(request.body);
    return runtime.createRun(body.input, body.workflowId, body.mode);
  });
  app.get("/v1/runs", async () => db.listRuns());
  app.get<{ Params: { id: string } }>("/v1/runs/:id", async (request, reply) => {
    const run = db.getRun(request.params.id);
    if (!run) return reply.code(404).send({ error: "not_found" });
    return { ...run, steps: db.listSteps(run.id), events: db.listEvents(run.id), artifacts: db.listArtifacts(run.id), memory: db.listMemory({ runId: run.id }) };
  });
  app.get<{ Params: { id: string } }>("/v1/runs/:id/events", async (request) => db.listEvents(request.params.id));
  app.get<{ Params: { id: string }; Querystring: { key?: string } }>("/v1/runs/:id/memory", async (request) => db.listMemory({ runId: request.params.id, key: request.query.key }));
  app.post<{ Params: { id: string } }>("/v1/runs/:id/interrupt", async (request) => runtime.interrupt(request.params.id));
  app.post<{ Params: { id: string } }>("/v1/runs/:id/cancel", async (request) => runtime.cancel(request.params.id));
  app.post<{ Params: { id: string } }>("/v1/runs/:id/retry", async (request) => runtime.retry(request.params.id));

  app.get("/v1/workflows", async () => db.listWorkflows());
  app.get<{ Params: { id: string } }>("/v1/workflows/:id", async (request, reply) => {
    const workflow = db.listWorkflows().find((item) => item.id === request.params.id);
    return workflow ?? reply.code(404).send({ error: "not_found" });
  });
  app.post("/v1/workflows/reload", async () => {
    for (const record of workflows.records()) db.upsertWorkflow(record);
    return db.listWorkflows();
  });

  app.get("/v1/skills", async () => db.listSkills());
  app.get<{ Params: { id: string } }>("/v1/skills/:id", async (request, reply) => {
    const skill = db.listSkills().find((item) => item.id === request.params.id);
    return skill ?? reply.code(404).send({ error: "not_found" });
  });
  app.post("/v1/skills/reload", async () => skillRegistry.reload());
  app.post<{ Params: { id: string } }>("/v1/skills/:id/enable", async (request, reply) => {
    const skill = skillRegistry.setEnabled(request.params.id, true);
    return skill ?? reply.code(404).send({ error: "not_found" });
  });
  app.post<{ Params: { id: string } }>("/v1/skills/:id/disable", async (request, reply) => {
    const skill = skillRegistry.setEnabled(request.params.id, false);
    return skill ?? reply.code(404).send({ error: "not_found" });
  });

  app.get("/v1/approvals", async () => db.listApprovals());
  app.post<{ Params: { id: string } }>("/v1/approvals/:id/approve", async (request) => runtime.approve(request.params.id, approvalDecisionSchema.parse(request.body ?? {})));
  app.post<{ Params: { id: string } }>("/v1/approvals/:id/reject", async (request) => runtime.reject(request.params.id, approvalDecisionSchema.parse(request.body ?? {})));

  app.get("/v1/artifacts", async () => db.listArtifacts());
  app.get<{ Params: { id: string } }>("/v1/artifacts/:id", async (request, reply) => {
    const artifact = db.getArtifact(request.params.id);
    return artifact ?? reply.code(404).send({ error: "not_found" });
  });
  app.get<{ Params: { id: string } }>("/v1/artifacts/:id/content", async (request, reply) => {
    const artifact = db.getArtifact(request.params.id);
    if (!artifact) return reply.code(404).send({ error: "not_found" });
    if (!existsSync(artifact.path) || !statSync(artifact.path).isFile()) {
      return reply.code(404).send({ error: "artifact_content_missing" });
    }
    return reply.type(artifact.mimeType ?? "application/octet-stream").send(createReadStream(artifact.path));
  });

  app.get("/v1/audit-logs", async () => db.listAuditLogs());
  app.get("/v1/jobs", async () => db.listJobs());
  app.post("/v1/jobs/expire-timeouts", async () => ({ expiredRunIds: db.expireTimedOutJobs() }));
  app.get("/v1/capabilities", async () => runtime.listCapabilities());
  app.get<{ Querystring: { runId?: string; key?: string } }>("/v1/memory", async (request) => db.listMemory({ runId: request.query.runId, key: request.query.key }));

  const workspaceConsoleDist = join(repoRoot, "packages", "console", "dist");
  const packagedConsoleDist = join(dirname(require.resolve("@sunpilot/console/package.json")), "dist");
  const consoleDist = existsSync(workspaceConsoleDist) ? workspaceConsoleDist : packagedConsoleDist;
  if (existsSync(consoleDist)) {
    await app.register(fastifyStatic, { root: consoleDist, prefix: "/" });
  } else {
    app.get("/", async () => ({
      product: "SunPilot",
      console: "Build packages/console to serve the local web console from the daemon."
    }));
  }

  const wsServer = new WebSocketServer({ noServer: true });
  const subscriptions = new Map<WebSocket, Set<string>>();
  const unsubscribeEvents = db.subscribeEvents((event) => {
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "run.event", params: { runId: event.runId, event } });
    for (const [socket, runIds] of subscriptions) {
      if (socket.readyState === WebSocket.OPEN && (runIds.has(event.runId) || runIds.has("*"))) {
        socket.send(notification);
      }
    }
  });
  wsServer.on("connection", (socket, request) => {
    if (bearerToken(request.headers.authorization) !== token && new URL(request.url ?? "/", `http://${host}:${port}`).searchParams.get("token") !== token) {
      socket.close(1008, "invalid token");
      return;
    }
    subscriptions.set(socket, new Set());
    socket.once("close", () => subscriptions.delete(socket));
    socket.on("message", async (raw) => {
      let message: { id?: string; method?: string; params?: any } = {};
      try {
        message = JSON.parse(String(raw)) as typeof message;
        if (message.method === "run.create") {
          const body = createRunSchema.parse(message.params ?? {});
          const run = await runtime.createRun(body.input, body.workflowId, body.mode);
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: run }));
          return;
        }
        if (message.method === "run.subscribe") {
          const runId = typeof message.params?.runId === "string" ? message.params.runId : "*";
          subscriptions.get(socket)?.add(runId);
          const events = runId === "*" ? [] : db.listEvents(runId);
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { runId, events } }));
          return;
        }
        if (message.method === "run.unsubscribe") {
          const runId = typeof message.params?.runId === "string" ? message.params.runId : "*";
          subscriptions.get(socket)?.delete(runId);
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { runId, subscribed: false } }));
          return;
        }
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }));
      } catch (error) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: rpcError(error) }));
      }
    });
  });

  return {
    app,
    paths,
    token,
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
      db.audit({ actor: "daemon", action: "daemon.start", target: `${host}:${port}`, payload: { host, port } });
      app.log.info({ host, port }, "SunPilot daemon started");
    },
    async stop() {
      db.audit({ actor: "daemon", action: "daemon.stop", target: `${host}:${port}`, payload: { host, port } });
      unsubscribeEvents();
      subscriptions.clear();
      wsServer.close();
      await app.close();
      db.close();
    }
  };
}
