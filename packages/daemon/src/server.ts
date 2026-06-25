import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { ZodError } from "zod";
import {
  AgentService,
  createDefaultLlmProvider,
  InMemoryAgentEventBus,
  parseEnv,
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
import { AuditActor, DEFAULT_EXTERNAL_ORIGINS } from "@sunpilot/protocol";
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
  // Missing Origin (non-browser clients: curl, scripts, same-host processes)
  // is NOT trusted by the origin check. Such clients must present the local
  // bearer token (see onRequest hook in createDaemon).
  if (!origin) return false;
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

/** Constant-time comparison of two secret strings; returns false on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a bearer token from an `Authorization` header value. */
function extractBearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const trimmed = header.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmed);
  return match?.[1]?.trim();
}

/**
 * Minimal in-memory sliding-window rate limiter.
 * Used because @fastify/rate-limit is not a project dependency. Limits per-IP
 * request counts within a rolling window; protects against trivial DoS.
 */
class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {}

  check(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const bucket = this.hits.get(ip);
    const fresh = bucket ? bucket.filter((ts) => ts > cutoff) : [];
    if (fresh.length >= this.maxRequests) {
      this.hits.set(ip, fresh);
      return false;
    }
    fresh.push(now);
    this.hits.set(ip, fresh);
    return true;
  }
}

const AUTH_EXEMPT_PATHS = new Set(["/healthz", "/readyz"]);

export async function createDaemon(options: DaemonOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 3737;
  const env = parseEnv(process.env);
  const paths = ensureSunPilotHome(getSunPilotPaths());
  const database = options.database ?? (await createDatabaseContext());
  const shouldCloseDatabase = !options.database;

  // ── Local token authentication (C9/C10) ────────────────────────────
  // The daemon can execute skills, read/write files, and call out to the
  // network on behalf of whoever drives it. To prevent any same-host process
  // from issuing commands, every non-exempt HTTP/WS request must present a
  // bearer token that this daemon generated at startup. The token is written
  // to ~/.sunpilot/runtime/token (mode 0600) so trusted local clients (CLI,
  // launcher, browser fetch via the web client) can read it.
  //
  // SUNPILOT_DISABLE_TOKEN_AUTH=1 opts out for local development / tests.
  const tokenAuthEnabled = env.SUNPILOT_DISABLE_TOKEN_AUTH !== "1";
  let localToken: string | undefined;
  if (tokenAuthEnabled) {
    try {
      // Reuse an existing token if a valid one is already on disk (e.g. daemon
      // restart within the same runtime), otherwise generate a fresh one.
      const existing = existsSync(paths.token)
        ? readFileSync(paths.token, "utf8").trim()
        : "";
      localToken = existing.length >= 32 ? existing : randomBytes(32).toString("hex");
      writeFileSync(paths.token, localToken, { mode: 0o600 });
    } catch (err) {
      console.warn("[daemon] Failed to persist local auth token:", (err as Error).message);
      localToken = randomBytes(32).toString("hex");
    }
  }

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
      timeoutMs: env.SUNPILOT_SKILL_TIMEOUT_MS,
      maxConcurrency: env.SUNPILOT_SKILL_MAX_CONCURRENCY,
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
    logger: { level: env.SUNPILOT_LOG_LEVEL },
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
  // ── Auth + rate limiting hook (C9/C10) ─────────────────────────────
  // Order: exempt health probes → rate limit → token auth → origin check.
  // - A valid bearer token authorizes any client (covers curl/CLI/scripts and
  //   the browser when it forwards the token).
  // - Without a token, only same-origin browser requests (Origin present and
  //   allowed) pass; non-browser clients without a token are rejected.
  const rateLimiter = new SlidingWindowRateLimiter(
    env.SUNPILOT_RATE_LIMIT_WINDOW_MS,
    env.SUNPILOT_RATE_LIMIT_MAX,
  );

  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 2)[0] ?? "";
    if (AUTH_EXEMPT_PATHS.has(path)) return;

    // Rate limit (per-IP sliding window).
    if (!rateLimiter.check(request.ip)) {
      await reply
        .code(429)
        .header("Retry-After", "1")
        .send({ error: "rate_limited", message: "Too many requests." });
      return;
    }

    if (tokenAuthEnabled) {
      const presented = extractBearerToken(request.headers.authorization);
      const tokenOk = presented && localToken ? safeEqual(presented, localToken) : false;
      if (!tokenOk) {
        // Fall back to Origin check for browser clients (which always send
        // Origin but may not forward the bearer token for same-origin calls).
        if (!isAllowedLocalOrigin(request.headers.origin, port)) {
          await reply
            .code(401)
            .send({ error: "unauthorized", message: "Missing or invalid token." });
        }
      }
    } else {
      // Token auth disabled (local dev): still enforce the Origin boundary
      // for browser clients. Non-browser clients are allowed in dev mode.
      const origin = request.headers.origin;
      if (origin !== undefined && !isAllowedLocalOrigin(origin, port)) {
        await reply.code(403).send({ error: "origin_not_allowed" });
      }
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
          env.SUNPILOT_LLM_API_KEY || env.SUNPILOT_DP_LLM_API_KEY,
        ),
        provider: "openai-compatible",
        model: env.SUNPILOT_LLM_MODEL ?? env.SUNPILOT_DP_LLM_MODEL ?? "deepseek-v4-flash",
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
      const hasSeed = !!env.SUNPILOT_SEED_LLM_API_KEY;
      const dpModel = env.SUNPILOT_DP_LLM_MODEL ?? env.SUNPILOT_LLM_MODEL ?? "deepseek-v4-flash";
      const seedModel = env.SUNPILOT_SEED_LLM_MODEL ?? "doubao-seed-2-0-lite-260428";
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
    // When token auth is enabled, WebSocket upgrades must present this token
    // (Authorization header or ?token= query). undefined disables the check.
    token: localToken,
    // Skip all auth checks when SUNPILOT_DISABLE_TOKEN_AUTH=1 (local dev/tests).
    authDisabled: !tokenAuthEnabled,
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
