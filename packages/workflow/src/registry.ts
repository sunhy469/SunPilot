import type { WorkflowPlan, WorkflowRecord } from "@sunpilot/protocol";

export interface BusinessWorkflow {
  id: string;
  title: string;
  version: string;
  description: string;
  match(
    input: unknown,
    context: Record<string, unknown>,
  ): Promise<{ score: number; reason: string }>;
  plan(input: unknown, context: Record<string, unknown>): Promise<WorkflowPlan>;
}

/**
 * WorkflowRegistry — 业务 Workflow 注册中心。
 *
 * Workflow 和 Skill 的区别：
 * - Skill 是单个可执行能力（读文件、写文件、执行 shell 命令），
 *   由 skill-runner 包的 SkillRunner 执行。
 * - Workflow 是多步骤编排（计划→审批→步骤执行），
 *   每个 BusinessWorkflow 包含 match（匹配度评估）和 plan（生成执行计划）。
 *
 * Workflow 被 Agent 调用时通过 ToolDecisionEngine 选择（skillId 以 "workflow." 开头），
 * 然后由 composition-root 的 toolExecutor 作为 Agent tool call 在当前 run 内执行。
 */
export class WorkflowRegistry {
  private readonly workflows = new Map<string, BusinessWorkflow>();

  register(workflow: BusinessWorkflow): void {
    this.workflows.set(workflow.id, workflow);
  }

  list(): BusinessWorkflow[] {
    return [...this.workflows.values()];
  }

  get(id: string): BusinessWorkflow | undefined {
    return this.workflows.get(id);
  }

  records(): WorkflowRecord[] {
    const now = new Date().toISOString();
    return this.list().map((workflow) => ({
      id: workflow.id,
      title: workflow.title,
      version: workflow.version,
      source: "local",
      enabled: true,
      definition: { description: workflow.description },
      createdAt: now,
      updatedAt: now,
    }));
  }
}
