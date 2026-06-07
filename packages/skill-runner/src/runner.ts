import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { ArtifactRecord, MemoryRecord, RunRecord, StepRecord, SunPilotEvent, SunPilotEventType } from "@sunpilot/protocol";
import { redactSensitive, writeArtifact, type SunPilotPaths } from "@sunpilot/storage";
import type { SkillDefinition } from "@sunpilot/skill-sdk";
import type { SkillRegistry } from "./registry.js";

export interface SkillRunnerOptions {
  timeoutMs?: number;
  maxConcurrency?: number;
}

export interface SkillRunnerStore {
  paths: SunPilotPaths;
  getRun(id: string): Promise<RunRecord | undefined> | RunRecord | undefined;
  appendEvent(event: SunPilotEvent): Promise<void> | void;
  insertArtifact(artifact: ArtifactRecord): Promise<void> | void;
  insertMemory(memory: MemoryRecord): Promise<void> | void;
  audit(record: { runId?: string; stepId?: string; actor: string; action: string; target: string; risk?: string; payload: unknown }): Promise<void> | void;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isPathAllowed(path: string, allowedPaths: string[] | undefined, skillRoot: string): boolean {
  if (!allowedPaths?.length) return false;
  const requested = resolve(path);
  return allowedPaths.some((allowedPath) => {
    const allowed = resolve(isAbsolute(allowedPath) ? allowedPath : join(skillRoot, allowedPath));
    return requested === allowed || requested.startsWith(`${allowed}${sep}`);
  });
}

const sunPilotEventTypes = new Set<string>([
  "run.created",
  "run.planning",
  "run.started",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.interrupted",
  "workflow.selected",
  "workflow.planned",
  "step.created",
  "step.started",
  "step.progress",
  "step.completed",
  "step.failed",
  "step.interrupted",
  "skill.loaded",
  "skill.execution.started",
  "skill.execution.completed",
  "skill.execution.failed",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "artifact.created",
  "memory.written",
  "audit.written"
]);

function normalizeSkillEvent(type: string, payload: unknown): { type: SunPilotEventType; payload: unknown } {
  if (type === "skill.progress") return { type: "step.progress", payload };
  if (sunPilotEventTypes.has(type)) return { type: type as SunPilotEventType, payload };
  return { type: "step.progress", payload: { type, payload } };
}

/**
 * SkillRunner — Skill 插件执行引擎。
 *
 * 为什么 SkillRunner 是独立包而不是放在 agent-kernel 里面：
 * - Skill 是"插件"概念：第三方可开发和安装 Skill，Skill 代码运行在独立沙箱中
 * - agent-kernel 负责"决策"，skill-runner 负责"执行"，两者通过 ExecutionOrchestrator 桥接
 * - skill-runner 提供完整的 SDK 上下文（events/files/memory/secrets/logger/artifacts），
 *   这是插件执行边界：Skill 代码不能直接访问 Agent 内部状态，只能通过 SDK 接口交互
 *
 * 并发控制：
 * - acquireSlot / releaseSlot 实现信号量模式，限制同时执行的 Skill 数量
 * - maxConcurrency 默认 4，通过 SUNPILOT_SKILL_MAX_CONCURRENCY 环境变量调整
 *
 * 超时控制：
 * - 每个 Skill 执行有超时限制（默认 5 分钟），超时后 abort 并记录审计日志
 */
export class SkillRunner {
  private activeExecutions = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly activeControllers = new Map<string, Set<AbortController>>();
  private readonly timeoutMs: number;
  private readonly maxConcurrency: number;

  constructor(
    private readonly db: SkillRunnerStore,
    private readonly registry: SkillRegistry,
    options: SkillRunnerOptions = {}
  ) {
    this.timeoutMs = positiveNumber(options.timeoutMs, 5 * 60_000);
    this.maxConcurrency = Math.floor(positiveNumber(options.maxConcurrency, 4));
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
    for (const controller of this.activeControllers.get(runId) ?? []) {
      controller.abort(new Error(`Run interrupted: ${runId}`));
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

    const manifestCapability = installed.manifest.capabilities.find((capability) => capability.name === step.capability);
    if (!manifestCapability) {
      throw new Error(`Capability not declared in manifest: ${step.capability}`);
    }
    if (installed.manifest.permissions.shell) {
      throw new Error("Permission denied: shell access is not allowed in MVP runner.");
    }
    if ((installed.manifest.permissions.network?.allow?.length ?? 0) > 0) {
      throw new Error("Permission denied: network access is not available in MVP runner.");
    }

    const module = (await import(this.registry.entryUrl(installed))) as { default?: SkillDefinition };
    const definition = module.default;
    if (!definition || definition.id !== installed.id || definition.version !== installed.version) {
      throw new Error("Loaded skill definition does not match manifest.");
    }
    const capability = definition.capabilities[step.capability];
    if (!capability) {
      throw new Error(`Skill definition does not export capability: ${step.capability}`);
    }

    await this.db.audit({ runId: step.runId, stepId: step.id, actor: "daemon", action: "skill.execute", target: `${step.skillId}:${step.capability}`, risk: capability.risk, payload: { input: step.input } });
    const parsedInput = capability.input.parse(step.input);
    const skillLog = (level: string, message: string, payload?: unknown) => {
      const entry = redactSensitive(
        { level, message, payload, runId: step.runId, stepId: step.id, skillId: step.skillId, capability: step.capability, createdAt: new Date().toISOString() },
        [this.db.paths.home]
      );
      appendFileSync(this.db.paths.logs + "/skill.log", JSON.stringify(entry) + "\n");
    };
    const controller = new AbortController();
    const db = this.db;
    const controllers = this.activeControllers.get(step.runId) ?? new Set<AbortController>();
    controllers.add(controller);
    this.activeControllers.set(step.runId, controllers);
    let timer: NodeJS.Timeout | undefined;
    const execution = capability.handler(parsedInput, {
      runId: step.runId,
      stepId: step.id,
      skillId: step.skillId,
      capability: step.capability,
      signal: controller.signal,
      events: {
        emit: (type, payload) => {
          const normalized = normalizeSkillEvent(type, payload);
          const event: SunPilotEvent = {
            id: `evt_${crypto.randomUUID()}`,
            runId: step.runId,
            stepId: step.id,
            type: normalized.type,
            payload: normalized.payload,
            createdAt: new Date().toISOString()
          };
          void this.db.appendEvent(event);
        }
      },
      artifacts: {
        write: async (input) => {
          const artifact = writeArtifact(this.db.paths, { runId: step.runId, stepId: step.id, ...input });
          await this.db.insertArtifact(artifact);
          await this.db.appendEvent({
            id: `evt_${crypto.randomUUID()}`,
            runId: step.runId,
            stepId: step.id,
            type: "artifact.created",
            payload: artifact,
            createdAt: new Date().toISOString()
          });
          return artifact;
        }
      },
      files: {
        readText: async (path) => {
          if (!isPathAllowed(path, installed.manifest.permissions.filesystem?.read, installed.path)) {
            throw new Error(`Permission denied: file read is not allowed for ${path}`);
          }
          await this.db.audit({ runId: step.runId, stepId: step.id, actor: "daemon", action: "file.read", target: path, payload: { skillId: step.skillId } });
          return readFile(path, "utf8");
        },
        writeText: async (path, content) => {
          if (!isPathAllowed(path, installed.manifest.permissions.filesystem?.write, installed.path)) {
            throw new Error(`Permission denied: file write is not allowed for ${path}`);
          }
          await this.db.audit({ runId: step.runId, stepId: step.id, actor: "daemon", action: "file.write", target: path, payload: { skillId: step.skillId, bytes: Buffer.byteLength(content) } });
          return writeFile(path, content, "utf8");
        }
      },
      memory: {
        async write(key, value) {
          const content = typeof value === "string" ? value : JSON.stringify(value);
          const now = new Date().toISOString();
          const memory: MemoryRecord = {
            id: `memory_${crypto.randomUUID()}`,
            runId: step.runId,
            stepId: step.id,
            key,
            value,
            scope: "run",
            scopeId: step.runId,
            type: "tool_observation",
            title: key,
            content,
            summary: content,
            source: "skill",
            confidence: 0.8,
            importance: 0.5,
            metadata: { skillId: step.skillId, capability: step.capability },
            createdAt: now,
            updatedAt: now
          };
          await db.insertMemory(memory);
          await db.audit({ runId: step.runId, stepId: step.id, actor: "daemon", action: "memory.write", target: key, risk: capability.risk, payload: { skillId: step.skillId, capability: step.capability } });
          await db.appendEvent({
            id: `evt_${crypto.randomUUID()}`,
            runId: step.runId,
            stepId: step.id,
            type: "memory.written",
            payload: { id: memory.id, key, metadata: memory.metadata },
            createdAt: new Date().toISOString()
          });
        }
      },
      secrets: {
        async get(name) {
          if (!(installed.manifest.permissions.env?.allow ?? []).includes(name)) {
            throw new Error(`Permission denied: secret ${name} is not allowed`);
          }
          await db.audit({ runId: step.runId, stepId: step.id, actor: "daemon", action: "secret.read", target: "[REDACTED_NAME]", risk: capability.risk, payload: { skillId: step.skillId } });
          return process.env[name];
        }
      },
      logger: {
        info(message, payload) { skillLog("info", message, payload); },
        warn(message, payload) { skillLog("warn", message, payload); },
        error(message, payload) { skillLog("error", message, payload); }
      }
    });
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error(`Skill execution timed out after ${this.timeoutMs}ms.`));
        void this.db.audit({
          runId: step.runId,
          stepId: step.id,
          actor: "daemon",
          action: "skill.timeout",
          target: `${step.skillId}:${step.capability}`,
          risk: capability.risk,
          payload: { timeoutMs: this.timeoutMs }
        });
        reject(controller.signal.reason);
      }, this.timeoutMs);
      timer.unref();
    });
    try {
      const result = await Promise.race([execution, timeout]);
      return capability.output.parse(result);
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
      if (controllers.size === 0) this.activeControllers.delete(step.runId);
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.activeExecutions >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeExecutions += 1;
  }

  private releaseSlot(): void {
    this.activeExecutions -= 1;
    this.waiters.shift()?.();
  }
}
