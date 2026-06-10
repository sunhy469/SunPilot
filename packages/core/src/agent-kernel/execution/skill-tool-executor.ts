import type { ArtifactRecord, InstalledSkillRecord, StepRecord } from "@sunpilot/protocol";
import type { ToolExecutor } from "./execution-types.js";
import type { ArtifactRef } from "../loop-types.js";

/**
 * SkillToolExecutor 依赖 — 由 composition-root 提供具体实现。
 */
export interface SkillToolExecutorDeps {
  /** 获取已安装的 skill registry 列表 */
  listSkills(): InstalledSkillRecord[];
  /** 执行 skill（由 skill-runner 包提供） */
  runSkill(step: StepRecord): Promise<unknown>;
  /** 创建 step 记录 */
  createStep(step: {
    id: string;
    runId: string;
    type: string;
    name: string;
    status: string;
    skillId?: string;
    capability?: string;
    input?: unknown;
  }): Promise<void>;
  /** 更新 step 状态 */
  updateStepStatus(
    id: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
    output?: unknown,
    error?: unknown,
  ): Promise<void>;
  /** 获取当前 run 的 artifact 列表 */
  listArtifacts(runId: string): Promise<ArtifactRecord[]>;
}

/**
 * SkillToolExecutor — 统一的 skill 工具执行器。
 *
 * 职责：
 * - 解析 skillId（支持全限定格式 <skill-id>:<capability-name>）→ 找到对应的 InstalledSkill + Capability
 * - 创建 step 记录
 * - 委托给 skill-runner 执行
 * - 收集产物、更新 step 状态
 *
 * 不创建 run，不使用 runtime store。
 * 所有事件由 ExecutionOrchestrator 统一处理。
 */
export class SkillToolExecutor implements ToolExecutor {
  constructor(private readonly deps: SkillToolExecutorDeps) {}

  async execute(input: Parameters<ToolExecutor["execute"]>[0]): ReturnType<ToolExecutor["execute"]> {
    const target = resolveCapability(this.deps.listSkills(), input.skillId);
    if (!target) {
      return {
        status: "failed",
        summary: `No enabled skill capability found for ${input.skillId}.`,
        artifacts: [],
        error: {
          code: "AGENT_TOOL_NOT_FOUND",
          message: `No enabled skill capability found for ${input.skillId}.`,
        },
      };
    }

    const beforeArtifacts = new Set(
      (await this.deps.listArtifacts(input.runId)).map((a) => a.id),
    );

    const step: StepRecord = {
      id: input.toolCallId,
      runId: input.runId,
      type: "skill",
      name: target.capability.title,
      status: "running",
      skillId: target.skill.id,
      capability: target.capability.name,
      input: input.arguments,
    };
    await this.deps.createStep({
      id: step.id,
      runId: step.runId,
      type: step.type,
      name: step.name,
      status: step.status,
      skillId: step.skillId,
      capability: step.capability,
      input: step.input,
    });

    try {
      const output = await this.deps.runSkill(step);
      await this.deps.updateStepStatus(step.id, "completed", output);
      const artifacts = (await this.deps.listArtifacts(input.runId))
        .filter((a) => !beforeArtifacts.has(a.id))
        .map(toArtifactRef);
      return {
        status: "completed",
        summary: summarizeOutput(output),
        content: typeof output === "string" ? output : undefined,
        artifacts,
      };
    } catch (error) {
      const status: "cancelled" | "failed" = input.signal.aborted
        ? "cancelled"
        : "failed";
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.updateStepStatus(step.id, status, undefined, {
        code:
          status === "cancelled"
            ? "AGENT_RUN_CANCELLED"
            : "AGENT_TOOL_EXECUTION_FAILED",
        message,
      });
      return {
        status,
        summary: message,
        artifacts: [],
        error: {
          code:
            status === "cancelled"
              ? "AGENT_RUN_CANCELLED"
              : "AGENT_TOOL_EXECUTION_FAILED",
          message,
        },
      };
    }
  }
}

function resolveCapability(
  skills: InstalledSkillRecord[],
  requested: string,
):
  | {
      skill: InstalledSkillRecord;
      capability: InstalledSkillRecord["manifest"]["capabilities"][number];
    }
  | undefined {
  const separator = requested.indexOf(":");
  const skillId = separator >= 0 ? requested.slice(0, separator) : undefined;
  const capabilityName =
    separator >= 0 ? requested.slice(separator + 1) : requested;

  if (skillId) {
    const skill = skills.find((item) => item.enabled && item.id === skillId);
    const capability = skill?.manifest.capabilities.find(
      (item) => item.name === capabilityName,
    );
    return skill && capability ? { skill, capability } : undefined;
  }

  // Backward compatibility only. New tool calls should always use
  // <skill-id>:<capability-name>.
  for (const skill of skills) {
    if (!skill.enabled) continue;
    const capability = skill.manifest.capabilities.find(
      (item) => item.name === capabilityName,
    );
    if (capability) return { skill, capability };
  }
  return undefined;
}

function summarizeOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined) return "Tool completed.";
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function toArtifactRef(artifact: ArtifactRecord): ArtifactRef {
  return {
    id: artifact.id,
    name: artifact.name,
    type: artifact.type,
    version: artifact.version,
  };
}
