import type { RunRecord, RunStatus } from "@sunpilot/protocol";

export interface CreateRunInput extends RunRecord {}

export interface ListRunsInput {
  limit?: number;
}

export interface RunRepository {
  create(input: CreateRunInput): Promise<RunRecord>;
  findById(id: string): Promise<RunRecord | null>;
  list(input?: ListRunsInput): Promise<RunRecord[]>;
  updateStatus(id: string, status: RunStatus, completedAt?: string): Promise<void>;
  updateContext(id: string, context: Record<string, unknown>): Promise<void>;
}
