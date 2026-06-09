import type { ToolExecutor } from "./execution-types.js";

/**
 * ToolExecutorBridge — 根据 skillId 前缀路由到正确的执行器。
 *
 * 路由规则：
 * - `workflow.*` → workflowExecutor
 * - 其他 → skillExecutor
 *
 * 不创建 run，不使用 runtime store。
 * 所有执行结果由调用方（ExecutionOrchestrator）统一处理事件和持久化。
 */
export class ToolExecutorBridge implements ToolExecutor {
  constructor(
    private readonly deps: {
      skillExecutor: ToolExecutor;
      workflowExecutor: ToolExecutor;
    },
  ) {}

  execute(input: Parameters<ToolExecutor["execute"]>[0]): ReturnType<ToolExecutor["execute"]> {
    if (input.skillId.startsWith("workflow.")) {
      return this.deps.workflowExecutor.execute(input);
    }
    return this.deps.skillExecutor.execute(input);
  }
}
