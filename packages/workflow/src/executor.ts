import type { WorkflowRecord, RunRecord } from "@sunpilot/protocol";

/**
 * Workflow tool 输入 — workflow 作为 Agent tool call 在当前 run 内执行。
 */
export interface WorkflowToolInput {
  workflowId: string;
  runId: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
}

/**
 * Workflow tool 结果 — 不创建新 run，产物通过 agent.* 事件发出。
 */
export interface WorkflowToolResult {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  content?: string;
  artifacts: Array<{
    id: string;
    name: string;
    type: string;
    version?: number;
  }>;
  error?: { code: string; message: string };
}

/**
 * Workflow 执行器依赖。
 */
export interface WorkflowToolExecutorDeps {
  /** 查找 workflow 定义 */
  findWorkflow(id: string): Promise<WorkflowRecord | null>;
  /** 获取当前 run 信息 */
  getRun(runId: string): Promise<RunRecord | undefined>;
  /** 创建 step 记录 */
  createStep(step: {
    id: string;
    runId: string;
    type: string;
    name: string;
    status: string;
    skillId?: string;
    input?: unknown;
  }): Promise<void>;
  /** 更新 step 状态 */
  updateStepStatus(
    id: string,
    status: string,
    output?: unknown,
    error?: unknown,
  ): Promise<void>;
}

/**
 * WorkflowToolExecutor — 将 workflow 作为 Agent tool call 在当前 run 内执行。
 *
 * 关键约束：
 * - 不创建新 run
 * - 不写旧 workflow 事件
 * - 进度通过 agent.tool.delta 发出（由 ExecutionOrchestrator 处理）
 * - 失败通过 agent.tool.failed 进入 Agent observation
 */
export class WorkflowToolExecutor {
  constructor(private readonly deps: WorkflowToolExecutorDeps) {}

  async execute(input: WorkflowToolInput): Promise<WorkflowToolResult> {
    const stepId = input.toolCallId;
    const workflowRecord = await this.deps.findWorkflow(input.workflowId);

    // ── Create step record BEFORE any early-exit checks ───────────
    // Every execution path (success, failed, cancelled, not-found)
    // must leave a step record for observability and UI display.
    await this.deps.createStep({
      id: stepId,
      runId: input.runId,
      type: "skill",
      name: workflowRecord?.title ?? `workflow.${input.workflowId}`,
      status: "running",
      skillId: `workflow.${input.workflowId}`,
      input: input.arguments,
    });

    // ── Pre-execution validation ──────────────────────────────────

    if (input.signal.aborted) {
      await this.deps.updateStepStatus(stepId, "cancelled", undefined, {
        code: "AGENT_RUN_CANCELLED",
        message: "Workflow cancelled before execution.",
      });
      return {
        status: "cancelled",
        summary: "Workflow cancelled before execution.",
        artifacts: [],
        error: { code: "AGENT_RUN_CANCELLED", message: "Workflow cancelled." },
      };
    }

    if (!workflowRecord) {
      await this.deps.updateStepStatus(stepId, "failed", undefined, {
        code: "AGENT_TOOL_NOT_FOUND",
        message: `Workflow ${input.workflowId} not found.`,
      });
      return {
        status: "failed",
        summary: `Workflow ${input.workflowId} not found.`,
        artifacts: [],
        error: {
          code: "AGENT_TOOL_NOT_FOUND",
          message: `Workflow ${input.workflowId} not found.`,
        },
      };
    }

    // ── Execute ───────────────────────────────────────────────────
    // Wrap getRun + execution in a single try so that a thrown error
    // during run retrieval also leaves the step in a failed state.
    try {
      const run = await this.deps.getRun(input.runId);
      if (!run) {
        await this.deps.updateStepStatus(stepId, "failed", undefined, {
          code: "AGENT_RUN_NOT_FOUND",
          message: `Run ${input.runId} not found.`,
        });
        return {
          status: "failed",
          summary: `Run ${input.runId} not found.`,
          artifacts: [],
          error: {
            code: "AGENT_RUN_NOT_FOUND",
            message: `Run ${input.runId} not found.`,
          },
        };
      }

      // Execute workflow definition as inline tool
      // Future: integrate with workflow.plan() and step execution
      const result: WorkflowToolResult = {
        status: "completed",
        summary: `Workflow ${workflowRecord.title} executed.`,
        content: JSON.stringify({
          workflowId: input.workflowId,
          title: workflowRecord.title,
          version: workflowRecord.version,
          definition: workflowRecord.definition,
        }),
        artifacts: [],
      };

      if (input.signal.aborted) {
        await this.deps.updateStepStatus(stepId, "cancelled", undefined, {
          code: "AGENT_RUN_CANCELLED",
          message: "Workflow cancelled during execution.",
        });
        return {
          status: "cancelled",
          summary: "Workflow cancelled during execution.",
          artifacts: [],
          error: {
            code: "AGENT_RUN_CANCELLED",
            message: "Workflow cancelled.",
          },
        };
      }

      await this.deps.updateStepStatus(stepId, "completed", result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deps.updateStepStatus(stepId, "failed", undefined, {
        code: "AGENT_WORKFLOW_EXECUTION_FAILED",
        message,
      });
      return {
        status: "failed",
        summary: message,
        artifacts: [],
        error: {
          code: "AGENT_WORKFLOW_EXECUTION_FAILED",
          message,
        },
      };
    }
  }
}
