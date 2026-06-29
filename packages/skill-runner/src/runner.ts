import { fork, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_EVENT_TYPES, AuditActor } from "@sunpilot/protocol";
import type {
  AgentEventType,
  ArtifactRecord,
  InstalledSkillRecord,
  MemoryRecord,
  RunRecord,
  StepRecord,
  SunPilotEvent,
} from "@sunpilot/protocol";
import { redactSensitive, writeArtifact, type SunPilotPaths } from "@sunpilot/storage";
import type { SkillRegistry } from "./registry.js";

export interface SkillRunnerOptions {
  timeoutMs?: number;
  maxConcurrency?: number;
  maxOldSpaceMb?: number;
  terminationGraceMs?: number;
}

export interface SkillRunnerStore {
  paths: SunPilotPaths;
  getRun(id: string): Promise<RunRecord | undefined> | RunRecord | undefined;
  appendEvent(event: SunPilotEvent): Promise<void> | void;
  insertArtifact(artifact: ArtifactRecord): Promise<void> | void;
  insertMemory(memory: MemoryRecord): Promise<void> | void;
  audit(record: {
    runId?: string;
    stepId?: string;
    actor: string;
    action: string;
    target: string;
    risk?: string;
    payload: unknown;
  }): Promise<void> | void;
}

interface RunnerRegistry {
  get(id: string): Promise<InstalledSkillRecord | undefined> | InstalledSkillRecord | undefined;
  entryUrl(skill: InstalledSkillRecord): string;
  verifyIntegrity?(skill: InstalledSkillRecord): void;
}

interface ActiveExecution {
  terminate(reason: Error): void;
}

interface WorkerMessage {
  type?: unknown;
  id?: unknown;
  method?: unknown;
  args?: unknown;
  value?: unknown;
  error?: { name?: unknown; message?: unknown };
}

interface SkillHttpRequest {
  method?: unknown;
  url?: unknown;
  headers?: unknown;
  query?: unknown;
  body?: unknown;
  timeoutMs?: unknown;
  responseType?: unknown;
}

const skillEventTypes = new Set<AgentEventType>(AGENT_EVENT_TYPES);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeSkillEvent(type: string, payload: unknown): { type: AgentEventType; payload: unknown } {
  if (type === "skill.progress") return { type: "agent.tool.delta", payload };
  if (skillEventTypes.has(type as AgentEventType)) return { type: type as AgentEventType, payload };
  return { type: "agent.tool.delta", payload: { type, payload } };
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);

  const suffix: string[] = [];
  let cursor = absolute;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error(`Path has no existing ancestor: ${path}`);
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function dependencyReadPaths(skillRoot: string): string[] {
  const nodeModules = join(skillRoot, "node_modules");
  if (!existsSync(nodeModules)) return [];
  const output = new Set<string>();
  const visit = (directory: string, depth: number) => {
    if (depth > 3 || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        output.add(realpathSync(path));
      } else if (entry.isDirectory()) {
        visit(path, depth + 1);
      }
    }
  };
  visit(nodeModules, 0);
  return [...output];
}

function resolveSkillFilePath(
  requestedPath: string,
  allowedPaths: string[] | undefined,
  skillRoot: string,
): string {
  if (!allowedPaths?.length) {
    throw new Error(`Permission denied: file access is not allowed for ${requestedPath}`);
  }
  const requested = canonicalPath(
    isAbsolute(requestedPath) ? requestedPath : join(skillRoot, requestedPath),
  );
  const allowed = allowedPaths.some((allowedPath) => {
    const root = canonicalPath(
      isAbsolute(allowedPath) ? allowedPath : join(skillRoot, allowedPath),
    );
    return requested === root || requested.startsWith(`${root}${sep}`);
  });
  if (!allowed) {
    throw new Error(`Permission denied: file access is not allowed for ${requestedPath}`);
  }
  return requested;
}

function isNetworkAllowed(url: URL, allowedHosts: string[] | undefined): boolean {
  if (!allowedHosts?.length) return false;
  return allowedHosts.some((allowed) => {
    const normalized = allowed.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return url.host === normalized || url.hostname === normalized || url.hostname.endsWith(`.${normalized}`);
  });
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") output[key] = entry;
  }
  return output;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    output[key] =
      lower === "authorization" || lower === "cookie" || lower.includes("token") ||
      lower.includes("key") || lower.includes("secret")
        ? "[REDACTED]"
        : value;
  }
  return output;
}

function buildRequestBody(body: unknown): BodyInit | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  return JSON.stringify(body);
}

function serializableError(error: unknown): { name: string; message: string } {
  return {
    name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function workerError(message: WorkerMessage): Error {
  const error = new Error(
    typeof message.error?.message === "string"
      ? message.error.message
      : "Isolated Skill execution failed.",
  );
  error.name = typeof message.error?.name === "string" ? message.error.name : "Error";
  return error;
}

/**
 * Executes every third-party Skill in a short-lived child process.
 *
 * The child receives an empty environment and Node's permission model blocks
 * direct filesystem/process access. Sensitive operations are implemented by
 * the parent through validated IPC calls. A timeout or run interruption kills
 * the process, so uncooperative Skill code cannot continue in the daemon.
 */
export class SkillRunner {
  private activeExecutions = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly activeByRun = new Map<string, Set<ActiveExecution>>();
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;
  private readonly maxOldSpaceMb: number;
  private readonly terminationGraceMs: number;

  constructor(
    private readonly db: SkillRunnerStore,
    private readonly registry: SkillRegistry | RunnerRegistry,
    options: SkillRunnerOptions = {},
  ) {
    this.timeoutMs = positiveNumber(options.timeoutMs, 5 * 60_000);
    this.maxConcurrency = Math.floor(positiveNumber(options.maxConcurrency, 4));
    this.maxOldSpaceMb = Math.floor(positiveNumber(options.maxOldSpaceMb, 256));
    this.terminationGraceMs = Math.floor(positiveNumber(options.terminationGraceMs, 250));
  }

  async execute(step: StepRecord): Promise<unknown> {
    await this.acquireSlot();
    try {
      if ((await this.db.getRun(step.runId))?.status === "interrupted") {
        throw new Error(`Run interrupted: ${step.runId}`);
      }
      return await this.executeWithSlot(step);
    } finally {
      this.releaseSlot();
    }
  }

  interruptRun(runId: string): void {
    const reason = new Error(`Run interrupted: ${runId}`);
    for (const execution of this.activeByRun.get(runId) ?? []) {
      execution.terminate(reason);
    }
  }

  private async executeWithSlot(step: StepRecord): Promise<unknown> {
    if (!step.skillId || !step.capability) {
      throw new Error("Skill step is missing skillId or capability.");
    }
    const installed = await this.registry.get(step.skillId);
    if (!installed || !installed.enabled) {
      throw new Error(`Skill is not installed or enabled: ${step.skillId}`);
    }
    const manifestCapability = installed.manifest.capabilities.find(
      (capability) => capability.name === step.capability,
    );
    if (!manifestCapability) {
      throw new Error(`Capability not declared in manifest: ${step.capability}`);
    }
    if (installed.manifest.permissions.shell) {
      throw new Error("Permission denied: direct shell access is not allowed in the isolated runner.");
    }
    try {
      this.registry.verifyIntegrity?.(installed);
    } catch (error) {
      await this.db.audit({
        runId: step.runId,
        stepId: step.id,
        actor: AuditActor.Daemon,
        action: "skill.integrity.rejected",
        target: `${step.skillId}:${step.capability}`,
        risk: "high",
        payload: serializableError(error),
      });
      throw error;
    }

    await this.db.audit({
      runId: step.runId,
      stepId: step.id,
      actor: AuditActor.Daemon,
      action: "skill.isolation.started",
      target: `${step.skillId}:${step.capability}`,
      risk: manifestCapability.risk,
      payload: { trust: installed.manifest.trust, isolation: "child-process" },
    });

    return this.executeInChild(step, installed, manifestCapability.risk);
  }

  private executeInChild(
    step: StepRecord,
    installed: InstalledSkillRecord,
    risk: string,
  ): Promise<unknown> {
    const workerPath = fileURLToPath(new URL("./isolated-worker.mjs", import.meta.url));
    const dependencyPaths = dependencyReadPaths(installed.path);
    const child = fork(workerPath, [], {
      cwd: installed.path,
      env: { LANG: "C", TZ: "UTC" },
      execArgv: [
        "--permission",
        `--allow-fs-read=${workerPath}`,
        `--allow-fs-read=${canonicalPath(installed.path)}`,
        ...dependencyPaths.map((path) => `--allow-fs-read=${path}`),
        `--max-old-space-size=${this.maxOldSpaceMb}`,
      ],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    return new Promise<unknown>((resolvePromise, rejectPromise) => {
      let settled = false;
      let terminalError: Error | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      const pendingHostCalls = new Set<Promise<void>>();

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        activeSet.delete(execution);
        if (activeSet.size === 0) this.activeByRun.delete(step.runId);
        child.removeAllListeners();
      };

      const settle = async (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        await Promise.allSettled([...pendingHostCalls]);
        cleanup();
        if (child.connected) child.disconnect();
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        if (error) rejectPromise(error);
        else resolvePromise(value);
      };

      const terminate = (reason: Error) => {
        if (settled || terminalError) return;
        terminalError = reason;
        if (child.connected) {
          child.send({ type: "abort", reason: reason.message }, () => undefined);
        }
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, this.terminationGraceMs);
        forceKillTimer.unref();
      };

      const execution: ActiveExecution = { terminate };
      const activeSet = this.activeByRun.get(step.runId) ?? new Set<ActiveExecution>();
      activeSet.add(execution);
      this.activeByRun.set(step.runId, activeSet);

      const sendHostResult = (id: string, ok: boolean, value?: unknown, error?: unknown) => {
        if (!child.connected) return;
        child.send({
          type: "host_result",
          id,
          ok,
          ...(ok ? { value } : { error: serializableError(error) }),
        }, () => undefined);
      };

      const handleHostMessage = (message: WorkerMessage, expectsReply: boolean) => {
        const method = typeof message.method === "string" ? message.method : "";
        const id = typeof message.id === "string" ? message.id : "";
        const task = this.handleHostCall(method, message.args, step, installed, risk)
          .then((value) => {
            if (expectsReply) sendHostResult(id, true, value);
          })
          .catch((error) => {
            if (expectsReply) sendHostResult(id, false, undefined, error);
            else void this.db.audit({
              runId: step.runId,
              stepId: step.id,
              actor: AuditActor.Daemon,
              action: "skill.notification.failed",
              target: `${installed.id}:${step.capability}`,
              risk,
              payload: serializableError(error),
            });
          });
        pendingHostCalls.add(task);
        void task.finally(() => pendingHostCalls.delete(task));
      };

      child.on("message", (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const message = raw as WorkerMessage;
        if (message.type === "host_call") {
          handleHostMessage(message, true);
        } else if (message.type === "host_notify") {
          handleHostMessage(message, false);
        } else if (message.type === "result") {
          void settle(undefined, message.value);
        } else if (message.type === "error") {
          void settle(workerError(message));
        }
      });
      child.once("error", (error) => void settle(terminalError ?? error));
      child.once("exit", (code, signal) => {
        if (settled) return;
        const error = terminalError ?? new Error(
          `Isolated Skill process exited before returning a result (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        );
        void settle(error);
      });

      timeout = setTimeout(() => {
        const error = new Error(`Skill execution timed out after ${this.timeoutMs}ms.`);
        void this.db.audit({
          runId: step.runId,
          stepId: step.id,
          actor: AuditActor.Daemon,
          action: "skill.timeout",
          target: `${step.skillId}:${step.capability}`,
          risk,
          payload: { timeoutMs: this.timeoutMs, terminated: true },
        });
        terminate(error);
      }, this.timeoutMs);
      timeout.unref();

      child.send({
        type: "execute",
        entryUrl: this.registry.entryUrl(installed),
        skillId: installed.id,
        version: installed.version,
        capability: step.capability,
        runId: step.runId,
        stepId: step.id,
        input: step.input,
      }, (error) => {
        if (error) void settle(error);
      });
    });
  }

  private async handleHostCall(
    method: string,
    args: unknown,
    step: StepRecord,
    installed: InstalledSkillRecord,
    risk: string,
  ): Promise<unknown> {
    const input = args && typeof args === "object" && !Array.isArray(args)
      ? args as Record<string, unknown>
      : {};

    if (method === "events.emit") {
      if (typeof input.type !== "string") throw new Error("Skill event type must be a string.");
      const normalized = normalizeSkillEvent(input.type, input.payload);
      await this.db.appendEvent({
        id: `evt_${crypto.randomUUID()}`,
        runId: step.runId,
        stepId: step.id,
        type: normalized.type,
        payload: normalized.payload,
        createdAt: new Date().toISOString(),
      });
      return undefined;
    }

    if (method === "artifacts.write") {
      if (typeof input.name !== "string" || typeof input.type !== "string") {
        throw new Error("Artifact name and type are required.");
      }
      if (typeof input.content !== "string" && !Buffer.isBuffer(input.content)) {
        throw new Error("Artifact content must be a string or Buffer.");
      }
      const artifact = writeArtifact(this.db.paths, {
        runId: step.runId,
        stepId: step.id,
        name: input.name,
        type: input.type as ArtifactRecord["type"],
        content: input.content,
        ...(typeof input.mimeType === "string" ? { mimeType: input.mimeType } : {}),
        ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
          ? { metadata: input.metadata as Record<string, unknown> }
          : {}),
      });
      await this.db.insertArtifact(artifact);
      await this.db.appendEvent({
        id: `evt_${crypto.randomUUID()}`,
        runId: step.runId,
        stepId: step.id,
        type: "agent.artifact.created",
        payload: artifact,
        createdAt: new Date().toISOString(),
      });
      return artifact;
    }

    if (method === "files.readText") {
      if (typeof input.path !== "string") throw new Error("File path must be a string.");
      const path = resolveSkillFilePath(
        input.path,
        installed.manifest.permissions.filesystem?.read,
        installed.path,
      );
      await this.db.audit({
        runId: step.runId,
        stepId: step.id,
        actor: AuditActor.Daemon,
        action: "file.read",
        target: path,
        payload: { skillId: step.skillId },
      });
      return readFile(path, "utf8");
    }

    if (method === "files.writeText") {
      if (typeof input.path !== "string" || typeof input.content !== "string") {
        throw new Error("File path and content must be strings.");
      }
      const path = resolveSkillFilePath(
        input.path,
        installed.manifest.permissions.filesystem?.write,
        installed.path,
      );
      await this.db.audit({
        runId: step.runId,
        stepId: step.id,
        actor: AuditActor.Daemon,
        action: "file.write",
        target: path,
        payload: { skillId: step.skillId, bytes: Buffer.byteLength(input.content) },
      });
      await writeFile(path, input.content, "utf8");
      return undefined;
    }

    if (method === "memory.write") {
      if (typeof input.key !== "string" || input.key.length === 0) {
        throw new Error("Memory key must be a non-empty string.");
      }
      const content = typeof input.value === "string" ? input.value : JSON.stringify(input.value);
      const now = new Date().toISOString();
      const memory: MemoryRecord = {
        id: `memory_${crypto.randomUUID()}`,
        runId: step.runId,
        stepId: step.id,
        key: input.key,
        value: input.value,
        scope: "run",
        scopeId: step.runId,
        type: "tool_observation",
        title: input.key,
        content,
        summary: content,
        source: "skill",
        confidence: 0.8,
        importance: 0.5,
        metadata: { skillId: step.skillId, capability: step.capability },
        createdAt: now,
        updatedAt: now,
      };
      await this.db.insertMemory(memory);
      await this.db.audit({
        runId: step.runId,
        stepId: step.id,
        actor: AuditActor.Daemon,
        action: "memory.write",
        target: input.key,
        risk,
        payload: { skillId: step.skillId, capability: step.capability },
      });
      await this.db.appendEvent({
        id: `evt_${crypto.randomUUID()}`,
        runId: step.runId,
        stepId: step.id,
        type: "agent.memory.written",
        payload: { id: memory.id, key: input.key, metadata: memory.metadata },
        createdAt: now,
      });
      return undefined;
    }

    if (method === "secrets.get") {
      if (typeof input.name !== "string") throw new Error("Secret name must be a string.");
      if (!(installed.manifest.permissions.env?.allow ?? []).includes(input.name)) {
        throw new Error(`Permission denied: secret ${input.name} is not allowed`);
      }
      await this.db.audit({
        runId: step.runId,
        stepId: step.id,
        actor: AuditActor.Daemon,
        action: "secret.read",
        target: "[REDACTED_NAME]",
        risk,
        payload: { skillId: step.skillId },
      });
      return process.env[input.name];
    }

    if (method === "http.request") {
      return this.performHttpRequest(input as SkillHttpRequest, step, installed, risk);
    }

    if (method.startsWith("logger.")) {
      const level = method.slice("logger.".length);
      if (!["info", "warn", "error"].includes(level) || typeof input.message !== "string") {
        throw new Error("Invalid Skill log entry.");
      }
      const entry = redactSensitive({
        level,
        message: input.message,
        payload: input.payload,
        runId: step.runId,
        stepId: step.id,
        skillId: step.skillId,
        capability: step.capability,
        createdAt: new Date().toISOString(),
      }, [this.db.paths.home]);
      appendFileSync(join(this.db.paths.logs, "skill.log"), `${JSON.stringify(entry)}\n`);
      return undefined;
    }

    throw new Error(`Unsupported Skill IPC method: ${method}`);
  }

  private async performHttpRequest(
    request: SkillHttpRequest,
    step: StepRecord,
    installed: InstalledSkillRecord,
    risk: string,
  ): Promise<unknown> {
    if (typeof request.url !== "string") throw new Error("HTTP request URL must be a string.");
    const method = typeof request.method === "string" ? request.method : "GET";
    const headers = stringRecord(request.headers);
    let url = new URL(request.url);
    if (request.query && typeof request.query === "object" && !Array.isArray(request.query)) {
      for (const [key, value] of Object.entries(request.query)) {
        if (["string", "number", "boolean"].includes(typeof value)) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const timeoutMs = Math.min(
      positiveNumber(typeof request.timeoutMs === "number" ? request.timeoutMs : undefined, 30_000),
      this.timeoutMs,
    );
    const signal = AbortSignal.timeout(timeoutMs);

    for (let redirect = 0; redirect <= 5; redirect += 1) {
      if (!isNetworkAllowed(url, installed.manifest.permissions.network?.allow)) {
        throw new Error(`Permission denied: network access is not allowed for ${url.host}`);
      }
      await this.db.audit({
        runId: step.runId,
        stepId: step.id,
        actor: AuditActor.Daemon,
        action: "network.request",
        target: url.origin,
        risk,
        payload: {
          skillId: step.skillId,
          capability: step.capability,
          method,
          url: `${url.origin}${url.pathname}`,
          headers: redactHeaders(headers),
        },
      });

      const response = await fetch(url, {
        method,
        headers: {
          ...(request.body !== undefined && typeof request.body !== "string"
            ? { "content-type": "application/json" }
            : {}),
          ...headers,
        },
        body: buildRequestBody(request.body),
        redirect: "manual",
        signal,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("HTTP redirect did not include a Location header.");
        if (redirect === 5) throw new Error("HTTP redirect limit exceeded.");
        url = new URL(location, url);
        continue;
      }

      const responseType = request.responseType ?? "json";
      const body = responseType === "arrayBuffer"
        ? Buffer.from(await response.arrayBuffer())
        : responseType === "text"
          ? await response.text()
          : await response.json();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    }
    throw new Error("HTTP redirect limit exceeded.");
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeExecutions >= this.maxConcurrency) {
      await new Promise<void>((resolveWaiter) => this.waiters.push(resolveWaiter));
    }
    this.activeExecutions += 1;
  }

  private releaseSlot(): void {
    this.activeExecutions -= 1;
    this.waiters.shift()?.();
  }
}
