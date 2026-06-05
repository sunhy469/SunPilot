import type { WorkflowRecord } from "@sunpilot/protocol";

export interface WorkflowRepository {
  upsert(input: WorkflowRecord): Promise<WorkflowRecord>;
  list(): Promise<WorkflowRecord[]>;
  findById(id: string): Promise<WorkflowRecord | null>;
}
