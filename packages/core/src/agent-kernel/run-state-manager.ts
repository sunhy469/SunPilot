import { AuditActor } from '@sunpilot/protocol';
import type {
  AgentLoopStatus,
  AgentLoopInput,
  AgentLoopResult,
  ToolDecision,
} from './loop-types.js';
import { isTerminal, LEGAL_TRANSITIONS } from './state/run-state-machine.js';

export interface RunState {
  runId: string;
  conversationId: string;
  status: AgentLoopStatus;
  previousStatus?: AgentLoopStatus;
  mode: string;
  goal?: string;
  error?: {
    code: string;
    message: string;
    category?: string;
    retryable?: boolean;
  };
  /** Persisted task state for multi-turn resume/retry support. */
  taskState?: {
    goal: string;
    completedSteps: string[];
    pendingSteps: string[];
    gatheredFacts: Record<string, unknown>;
    openQuestions: string[];
    iteration: number;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface RunStateManager {
  createRun(input: AgentLoopInput): Promise<RunState>;
  markStatus(runId: string, nextStatus: AgentLoopStatus, reason?: string): Promise<RunState>;
  markFailed(runId: string, error: unknown): Promise<RunState>;
  markCompleted(runId: string, result: AgentLoopResult): Promise<RunState>;
  markCancelled(runId: string, reason?: string): Promise<RunState>;
  getRun(runId: string): Promise<RunState | undefined>;
  /** Persist task state for multi-turn resume/retry. */
  saveTaskState(
    runId: string,
    taskState: NonNullable<RunState["taskState"]>,
  ): Promise<void>;
}

/**
 * In-memory RunStateManager for MVP.
 * Phase 6 will add PostgreSQL-backed persistence.
 */
export class InMemoryRunStateManager implements RunStateManager {
  private runs = new Map<string, RunState>();
  private history: Array<{
    runId: string;
    previousStatus?: string;
    nextStatus: string;
    reason?: string;
    actor: string;
    createdAt: string;
  }> = [];

  async createRun(input: AgentLoopInput): Promise<RunState> {
    const now = new Date().toISOString();
    const state: RunState = {
      runId: input.runId,
      conversationId: input.conversationId,
      status: 'created',
      mode: input.mode,
      goal: input.message,
      createdAt: now,
      updatedAt: now,
    };
    this.runs.set(input.runId, state);
    this.recordHistory(input.runId, undefined, 'created', 'run created');
    return state;
  }

  async markStatus(
    runId: string,
    nextStatus: AgentLoopStatus,
    reason?: string,
  ): Promise<RunState> {
    const current = this.runs.get(runId);
    if (!current) {
      throw Object.assign(new Error(`Unknown run: ${runId}`), {
        code: 'AGENT_RUN_NOT_FOUND',
      });
    }

    // Allow same-status transitions (idempotent)
    if (current.status === nextStatus) return current;

    // Terminal states cannot transition further. If we're already in a
    // terminal state, log and return — don't throw, because the caller
    // may be an async path that doesn't know the run already ended.
    if (isTerminal(current.status as AgentLoopStatus)) {
      console.warn(
        `[RunStateManager] run ${runId} is already terminal (${current.status}), ignoring transition to ${nextStatus}`,
      );
      return current;
    }

    // Validate transition
    const allowed = LEGAL_TRANSITIONS[current.status];
    if (!allowed || !allowed.includes(nextStatus)) {
      throw Object.assign(
        new Error(
          `Illegal state transition: ${current.status} -> ${nextStatus} for run ${runId}`,
        ),
        { code: 'AGENT_RUN_STATE_CONFLICT' },
      );
    }

    const now = new Date().toISOString();
    const previousStatus = current.status;
    const updated: RunState = {
      ...current,
      status: nextStatus,
      previousStatus,
      updatedAt: now,
      ...(nextStatus === 'completed' ? { completedAt: now } : {}),
      ...(nextStatus === 'cancelled' ? { cancelledAt: now } : {}),
    };
    this.runs.set(runId, updated);
    this.recordHistory(runId, previousStatus, nextStatus, reason ?? 'state transition');
    return updated;
  }

  async markFailed(runId: string, error: unknown): Promise<RunState> {
    const err = error instanceof Error ? error : new Error(String(error));
    const agentError = {
      code: (error as { code?: string }).code ?? 'AGENT_INTERNAL_ERROR',
      message: err.message,
      category: (error as { category?: string }).category ?? 'internal',
      retryable: (error as { retryable?: boolean }).retryable ?? false,
    };

    const current = this.runs.get(runId);
    if (!current) {
      throw Object.assign(new Error(`Unknown run: ${runId}`), {
        code: 'AGENT_RUN_NOT_FOUND',
      });
    }

    const now = new Date().toISOString();
    const updated: RunState = {
      ...current,
      status: 'failed',
      previousStatus: current.status,
      error: agentError,
      updatedAt: now,
      completedAt: now,
    };
    this.runs.set(runId, updated);
    this.recordHistory(runId, current.status, 'failed', err.message);
    return updated;
  }

  async markCompleted(runId: string, _result: AgentLoopResult): Promise<RunState> {
    return this.markStatus(runId, 'completed', 'run completed');
  }

  async markCancelled(runId: string, reason?: string): Promise<RunState> {
    return this.markStatus(runId, 'cancelled', reason ?? 'user cancelled');
  }

  async getRun(runId: string): Promise<RunState | undefined> {
    return this.runs.get(runId);
  }

  async saveTaskState(
    runId: string,
    taskState: NonNullable<RunState["taskState"]>,
  ): Promise<void> {
    const current = this.runs.get(runId);
    if (!current) return; // run may have completed/cleaned up
    current.taskState = taskState;
    this.runs.set(runId, current);
  }

  /** Write to run_status_history (in-memory for now, DB-backed in Phase 6). */
  private recordHistory(
    runId: string,
    previousStatus: string | undefined,
    nextStatus: string,
    reason: string,
  ): void {
    this.history.push({
      runId,
      previousStatus,
      nextStatus,
      reason,
      actor: AuditActor.System,
      createdAt: new Date().toISOString(),
    });
  }

  /** Get status history for a run (for debugging/recovery). */
  getHistory(runId: string): ReadonlyArray<{
    runId: string;
    previousStatus?: string;
    nextStatus: string;
    reason?: string;
    actor: string;
    createdAt: string;
  }> {
    return this.history.filter((h) => h.runId === runId);
  }
}
