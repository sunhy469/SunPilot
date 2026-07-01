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
    input: {
      status: RunStatus;
      updatedAt?: string;
      completedAt?: string;
      cancelledAt?: string;
      error?: unknown;
    },
  ): Promise<void>;
  /** Atomically update only when the persisted status still matches expected. */
  updateStatusIfCurrent?(
    id: string,
    expectedStatus: RunStatus,
    input: {
      status: RunStatus;
      updatedAt?: string;
      completedAt?: string;
      cancelledAt?: string;
      error?: unknown;
    },
  ): Promise<boolean>;
  /**
   * Atomically update only when the persisted status is one of the expected set.
   * Used by acquireExecution to obtain an execution lease via CAS against
   * multiple valid pre-running states (created/waiting_approval/waiting_user/interrupted).
   */
  updateStatusIfInSet?(
    id: string,
    expectedStatuses: RunStatus[],
    input: {
      status: RunStatus;
      updatedAt?: string;
    },
  ): Promise<boolean>;
  updateContext(id: string, context: Record<string, unknown>): Promise<void>;
  /** Merge a partial context without replacing concurrently-written keys. */
  patchContext?(id: string, patch: Record<string, unknown>): Promise<void>;
  /**
   * Count non-terminal runs attached to a conversation. Used by the
   * conversation delete guard to block deleting a conversation that still
   * has an in-flight run (created/running/waiting_approval/waiting_user/interrupted).
   */
  countActiveRunsByConversation(
    conversationId: string,
  ): Promise<number>;
  /**
   * Find the most recent non-terminal run for a conversation. Used by the
   * active-run endpoint to restore waiting_user/waiting_approval/interrupted
   * state after page refresh or daemon restart.
   */
  findLatestActiveByConversation(
    conversationId: string,
  ): Promise<RunRecord | null>;
}
