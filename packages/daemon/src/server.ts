import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply } from "fastify";
import { ZodError } from "zod";
import {
  AgentService,
  InMemoryAgentEventBus,
  parseEnv,
  RepositoryApprovalExpiryService,
  RuntimeError,
  SummaryStaleDetector,
  type AgentEventBus,
  type LlmProvider,
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
  /** Explicit provider injection for hermetic tests and embedded deployments. */
  llmProvider?: LlmProvider;
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
 *
 * Memory management: empty buckets are deleted immediately in `check()`, and
 * a periodic sweep removes any buckets that have fully expired. This prevents
 * unbounded Map growth when many distinct IPs are seen (e.g., behind a proxy
 * with spoofed X-Forwarded-For headers).
 */
class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
  ) {
    // Periodic sweep: remove expired buckets every windowMs.
    // This catches buckets that were last accessed near the end of a window
    // and would otherwise linger until the same IP hits again.
    this.sweepTimer = setInterval(() => this.sweep(), this.windowMs);
    this.sweepTimer.unref?.();
  }

  check(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const bucket = this.hits.get(ip);
    const fresh = bucket ? bucket.filter((ts) => ts > cutoff) : [];
    if (fresh.length >= this.maxRequests) {
      // Rate limited — update the bucket (with trimmed timestamps) but
      // don't add a new entry. Return false.
      this.hits.set(ip, fresh);
      return false;
    }
    // Under the limit — add this request's timestamp.
    fresh.push(now);
    this.hits.set(ip, fresh);
    return true;
  }

  /** Remove all buckets whose entries have all expired. */
  private sweep(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [ip, bucket] of this.hits) {
      const fresh = bucket.filter((ts) => ts > cutoff);
      if (fresh.length === 0) {
        this.hits.delete(ip);
      } else if (fresh.length !== bucket.length) {
        this.hits.set(ip, fresh);
      }
    }
  }

  dispose(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    this.hits.clear();
  }
}

const AUTH_EXEMPT_PATHS = new Set(["/healthz", "/readyz"]);

function requiresLocalAuthorization(path: string): boolean {
  return path === "/metrics" || path.startsWith("/v1/");
}

function linuxProcessStartTicks(pid = process.pid): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return undefined;
    // Fields after `(comm)` start at field 3 (state); starttime is field 22.
    return stat.slice(commandEnd + 1).trim().split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function configuredSkillDirectories(
  directories: string[],
  home: string,
): string[] {
  return [...new Set(directories.map((directory) =>
    resolve(isAbsolute(directory) ? directory : join(home, directory)),
  ))];
}

function skillDirectoryFingerprint(roots: string[]): string {
  const output: string[] = [];
  const visit = (directory: string) => {
    if (output.length >= 20_000 || !existsSync(directory)) return;
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink()) return;
    output.push(`${directory}:${directoryStat.mtimeMs}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        const stat = lstatSync(path);
        output.push(`${path}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  for (const root of roots) visit(root);
  return output.join("\n");
}

function watchSkillDirectories(
  roots: string[],
  reload: () => Promise<unknown>,
  onError: (error: unknown) => void,
): () => void {
  let fingerprint = skillDirectoryFingerprint(roots);
  let reloading = false;
  const timer = setInterval(() => {
    if (reloading) return;
    try {
      const next = skillDirectoryFingerprint(roots);
      if (next === fingerprint) return;
      fingerprint = next;
      reloading = true;
      void reload()
        .then(() => { fingerprint = skillDirectoryFingerprint(roots); })
        .catch(onError)
        .finally(() => { reloading = false; });
    } catch (error) {
      onError(error);
    }
  }, 1_000);
  timer.unref();

  return () => {
    clearInterval(timer);
  };
}

export async function createDaemon(options: DaemonOptions = {}) {
  const env = parseEnv(process.env);
  const paths = ensureSunPilotHome(getSunPilotPaths());
  const runtimeConfig = readSunPilotConfig(paths);
  const host = options.host ?? runtimeConfig.server.host;
  const port = options.port ?? (
    process.env.SUNPILOT_PORT !== undefined
      ? env.SUNPILOT_PORT
      : runtimeConfig.server.port
  );
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
  const tokenAuthEnabled = process.env.SUNPILOT_DISABLE_TOKEN_AUTH !== undefined
    ? env.SUNPILOT_DISABLE_TOKEN_AUTH !== "1"
    : runtimeConfig.security.requireLocalToken;
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

  const approvalExpiryService = new RepositoryApprovalExpiryService(database, eventBus);
  await approvalExpiryService.expireStale();
  await recoverAgentRuntimeRuns(database);

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const skillDirectories = configuredSkillDirectories(
    runtimeConfig.skills.directories,
    paths.home,
  );
  const skillRegistry = new SkillRegistry(database, skillDirectories);
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
  let _skillEmbeddingCache: { invalidate(skillIds?: string[]): void } | undefined;
  let _embeddingService: { invalidateCache(): void } | undefined;
  const getChatAgent = async (): Promise<AgentService> => {
    if (chatAgent) return chatAgent as AgentService;
    chatAgentInit ??= (async () => {
      const { service, modelRouter, updateMemory, skillEmbeddingCache, embeddingService } = createAgentLoopService({
        database,
        skillRegistry,
        skillRunner,
        llmProvider: options.llmProvider,
        enableEnvironmentProviders: !options.llmProvider,
        eventBus,
        liveEventBus,
        systemPrompt: "You are SunPilot, a concise business agent assistant.",
      });
      chatAgent = service;
      modelRouterRef = modelRouter;
      _updateMemory = updateMemory;
      _skillEmbeddingCache = skillEmbeddingCache;
      _embeddingService = embeddingService;
      return chatAgent as AgentService;
    })();
    return chatAgentInit;
  };

  const app = Fastify({
    logger: { level: env.SUNPILOT_LOG_LEVEL },
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RuntimeError) {
      if (error.statusCode >= 500) {
        app.log.error(
          { err: error, url: request.url, method: request.method },
          "Runtime error in request",
        );
        return reply.code(error.statusCode).send({
          error: error.code,
          message: "An internal server error occurred.",
        });
      }
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
    // Log the full error server-side with request context for debugging,
    // but return a generic message to the client to avoid leaking internal
    // details (database SQL, LLM response bodies, file paths, etc.).
    app.log.error(
      { err: error, url: request.url, method: request.method },
      "Unhandled error in request",
    );
    return reply.code(500).send({
      error: "internal_error",
      message: "An internal server error occurred.",
    });
  });
  // ── Auth + rate limiting hook (C9/C10) ─────────────────────────────
  // Order: exempt health probes → rate limit → token auth → origin check.
  // - A valid bearer token authorizes any client (covers curl/CLI/scripts and
  //   the browser when it forwards the token).
  // - Static UI assets remain public so the browser can bootstrap. Every
  //   stateful/API route requires the bearer token when token auth is enabled;
  //   Origin/Host are not authentication and can be spoofed by scripts.
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

    if (!requiresLocalAuthorization(path)) return;

    if (tokenAuthEnabled) {
      const presented = extractBearerToken(request.headers.authorization);
      const tokenOk = presented && localToken ? safeEqual(presented, localToken) : false;
      if (!tokenOk) {
        await reply
          .code(401)
          .send({ error: "unauthorized", message: "Missing or invalid token." });
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
      reload: async () => {
        const result = await skillRegistry.reload();
        // Invalidate embedding caches so stale skill embeddings are
        // recomputed on next access with the reloaded descriptions.
        _skillEmbeddingCache?.invalidate();
        _embeddingService?.invalidateCache();
        return result;
      },
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
      const hasSeed = !options.llmProvider && !!env.SUNPILOT_SEED_LLM_API_KEY;
      const hasDp = Boolean(
        options.llmProvider ||
        env.SUNPILOT_DP_LLM_API_KEY ||
        env.SUNPILOT_LLM_API_KEY ||
        env.DEEPSEEK_API_KEY
      );
      const dpModel = env.SUNPILOT_DP_LLM_MODEL ?? env.SUNPILOT_LLM_MODEL ?? "deepseek-v4-flash";
      const seedModel = env.SUNPILOT_SEED_LLM_MODEL ?? "doubao-seed-2-0-lite-260428";
      return [
        { id: "dp", label: "Deepseek-v4-flash", provider: "deepseek", model: dpModel, available: hasDp },
        { id: "seed", label: "Seed-2.0-lite", provider: "volcengine-ark", model: seedModel, available: hasSeed },
      ];
    },
    getDefaultModelId: () => !options.llmProvider && env.SUNPILOT_SEED_LLM_API_KEY
      ? "seed"
      : "dp",
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

      // Collect artifacts from the run if completed.
      // The agent loop emits `artifacts` as an array of artifact IDs (string[]),
      // NOT as objects. We must load the actual ArtifactRecord from the
      // database to obtain type/name/path for the WorldArtifact.
      const artifacts: Array<{ type: string; title: string; uri?: string }> = [];
      if (runStatus === "completed" && event.payload) {
        const payload = event.payload as Record<string, unknown>;
        const rawArtifacts = payload["artifacts"];
        if (Array.isArray(rawArtifacts)) {
          // Each element is an artifact ID string.
          const artifactIds = rawArtifacts.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
          for (const id of artifactIds) {
            const record = await database.artifacts.findById(id);
            if (record) {
              artifacts.push({
                type: record.type,
                title: record.name,
                uri: record.path || record.storageKey,
              });
            }
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
  // ── Domain-based landing page for tradeagent.asia ─────────────────
  // When accessed via the tradeagent.asia domain, serve the static
  // landing page instead of the SPA. Other domains / localhost continue
  // to serve the normal React app.
  if (existsSync(webDist)) {
    const LANDING_DOMAIN = "tradeagent.asia";

    // Helper: serve the SPA index.html
    const serveSpaIndex = (reply: FastifyReply) => {
      const indexPath = join(webDist, "index.html");
      if (existsSync(indexPath)) {
        const html = readFileSync(indexPath, "utf-8");
        return reply.type("text/html").send(html);
      }
      return reply.callNotFound();
    };

    // GET / — landing page for tradeagent.asia, SPA otherwise.
    // When ?app query param is present, skip the landing page so
    // /sunpilot can redirect here and land on the normal SPA.
    app.get("/", async (request, reply) => {
      const host = request.hostname;
      const isLandingDomain =
        host === LANDING_DOMAIN || host?.endsWith("." + LANDING_DOMAIN);
      const hasAppParam = "app" in (request.query as Record<string, unknown>);
      if (isLandingDomain && !hasAppParam) {
        const landingPath = join(webDist, "landing.html");
        if (existsSync(landingPath)) {
          const html = readFileSync(landingPath, "utf-8");
          return reply.type("text/html").send(html);
        }
      }
      return serveSpaIndex(reply);
    });

    // /sunpilot and /sunpilot/* — redirect to /?app so the SPA loads
    // at the root path, bypassing the tradeagent.asia landing page.
    app.get("/sunpilot", async (_request, reply) => {
      return reply.redirect("/?app", 302);
    });
    app.get("/sunpilot/*", async (_request, reply) => {
      return reply.redirect("/?app", 302);
    });

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
  // §F5: periodic idempotency key cleanup — removes expired in-flight
  // reservations so they don't block retries indefinitely.
  let idempotencyCleanupTimer: ReturnType<typeof setInterval> | null = null;
  let approvalExpiryTimer: ReturnType<typeof setInterval> | null = null;
  let stopSkillWatcher: (() => void) | undefined;

  return {
    app,
    paths,
    runtime: {
      host,
      port,
      tokenAuthEnabled,
      skillDirectories,
      skillAutoReload: runtimeConfig.skills.autoReload,
    },
    async start() {
      await app.listen({ host, port });
      // P1-12: Write a structured PID file with a stable Linux process-birth
      // identity. The launcher verifies it before signaling so a reused PID
      // can never cause it to kill an unrelated process.
      writeFileSync(
        paths.pidFile,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          processStartTicks: linuxProcessStartTicks(),
        }),
        { mode: 0o600 },
      );
      ws.attach(app.server);

      // Start background workers
      staleDetectionWorker.start();
      pruningWorker.start();
      approvalExpiryTimer = setInterval(async () => {
        try {
          const expired = await approvalExpiryService.expireStale();
          if (expired.length > 0) {
            const agent = await getChatAgent();
            for (const result of expired) {
              if (result.runCancelled) {
                (agent as AgentService & { disposeRun?: (runId: string) => void })
                  .disposeRun?.(result.runId);
              }
            }
            app.log.info({ count: expired.length }, "Expired stale approvals");
          }
        } catch (err) {
          app.log.warn({ err }, "Approval expiry scan failed");
        }
      }, 60_000);
      approvalExpiryTimer.unref?.();
      if (runtimeConfig.skills.autoReload) {
        stopSkillWatcher = watchSkillDirectories(
          skillDirectories,
          apiDeps.skills.reload,
          (error) => app.log.warn({ err: error }, "Skill auto-reload watcher failed"),
        );
      }
      // §F5: clean up expired idempotency keys every 10 minutes
      idempotencyCleanupTimer = setInterval(async () => {
        try {
          const count = await database.idempotency.cleanupExpired();
          if (count > 0) {
            app.log.info({ count }, "Cleaned up expired idempotency keys");
          }
        } catch (err) {
          app.log.warn({ err }, "Idempotency cleanup failed");
        }
      }, 600_000);
      if (idempotencyCleanupTimer && typeof (idempotencyCleanupTimer as { unref?: () => void }).unref === "function") {
        (idempotencyCleanupTimer as { unref: () => void }).unref();
      }

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
      stopSkillWatcher?.();
      stopSkillWatcher = undefined;
      if (idempotencyCleanupTimer) {
        clearInterval(idempotencyCleanupTimer);
        idempotencyCleanupTimer = null;
      }
      if (approvalExpiryTimer) {
        clearInterval(approvalExpiryTimer);
        approvalExpiryTimer = null;
      }
      rateLimiter.dispose();

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
