import type { RunMode, RunRecord, RunStatus } from "@sunpilot/protocol";

export interface CreateRunInput extends RunRecord {}

export interface ListRunsInput {
  limit?: number;
  status?: RunStatus;
  mode?: RunMode;
  conversationId?: string;
  cursor?: string;
}

export interface RunRepository {
  create(input: CreateRunInput): Promise<RunRecord>;
  findById(id: string): Promise<RunRecord | null>;
  list(input?: ListRunsInput): Promise<RunRecord[]>;
  updateStatus(
    id: string,
    status: RunStatus,
    completedAt?: string,
    error?: unknown,
  ): Promise<void>;
  updateContext(id: string, context: Record<string, unknown>): Promise<void>;
}
