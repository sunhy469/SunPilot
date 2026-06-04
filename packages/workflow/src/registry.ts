import type { WorkflowPlan, WorkflowRecord } from "@sunpilot/protocol";

export interface BusinessWorkflow {
  id: string;
  title: string;
  version: string;
  description: string;
  match(input: unknown, context: Record<string, unknown>): Promise<{ score: number; reason: string }>;
  plan(input: unknown, context: Record<string, unknown>): Promise<WorkflowPlan>;
}

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
      source: "fixture",
      enabled: true,
      definition: { description: workflow.description },
      createdAt: now,
      updatedAt: now
    }));
  }
}
