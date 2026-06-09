import type { WorkflowToolExecutor } from "@sunpilot/workflow";
import type { ToolExecutor } from "./execution-types.js";

/**
 * WorkflowToolExecutorAdapter — 将 WorkflowToolExecutor 适配为 ToolExecutor 接口。
 *
 * 负责从 skillId 中提取 workflowId，并将 ToolExecutor 接口映射到
 * WorkflowToolExecutor 的内部接口。
 */
export class WorkflowToolExecutorAdapter implements ToolExecutor {
  constructor(private readonly executor: WorkflowToolExecutor) {}

  execute(input: {
    runId: string;
    toolCallId: string;
    skillId: string;
    name: string;
    arguments: Record<string, unknown>;
    timeoutMs: number;
    signal: AbortSignal;
  }): ReturnType<ToolExecutor["execute"]> {
    const workflowId = input.skillId.slice("workflow.".length);
    return this.executor.execute({
      workflowId,
      runId: input.runId,
      toolCallId: input.toolCallId,
      arguments: input.arguments,
      signal: input.signal,
    });
  }
}
