import type { StepRecord, StepStatus } from "@sunpilot/protocol";

export interface StepRepository {
  create(input: StepRecord): Promise<StepRecord>;
  listByRunId(runId: string): Promise<StepRecord[]>;
  updateStatus(stepId: string, status: StepStatus, output?: unknown, error?: unknown): Promise<void>;
}
