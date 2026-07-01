import type { RunRecord } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type {
  AgentLoopInput,
  AgentLoopResult,
  AgentLoopStatus,
} from "../loop-types.js";
import type { RunState, RunStateManager } from "../run-state-manager.js";
import { LEGAL_TRANSITIONS, isTerminal } from "../state/run-state-machine.js";
import { AuditActor } from "../audit/audit-actor.js";

/**
 * RepositoryRunStateManager — PostgreSQL 持久化的 Run 状态管理器。
 *
 * 与 InMemoryRunStateManager 的接口完全相同，但所有状态写入都经过 DatabaseContext。
 * 每次状态变更同时写入三处：
 * 1. runs 表（主记录：status、completedAt、error）
 * 2. runs.context.statusHistory（JSON 数组，用于恢复状态历史）
 * 3. run_status_history 表（独立表，支持按 runId 查询变更历史）
 *
 * 状态转换验证规则共享 run-state-machine.ts 中的 LEGAL_TRANSITIONS 表。
 */
export class RepositoryRunStateManager implements RunStateManager {
  constructor(private readonly db: DatabaseContext) {}

  async createRun(input: AgentLoopInput): Promise<RunState> {
    const now = new Date().toISOString();
    const run: RunRecord = {
      id: input.runId,
      title: titleFromGoal(input.message),
      status: "created",
      mode: input.mode,
      conversationId: input.conversationId,
      userId: input.userId,
      goal: input.message,
      createdAt: now,
      updatedAt: now,
      input: {
        version: 1,
        message: input.message,
        attachments: input.attachments ?? [],
        client: input.client,
        permissionMode: input.permissionMode ?? "auto",
        modelId: input.modelId,
        mode: input.mode,
        userMessageId: input.userMessageId,
      },
      context: {
        agentStatus: "created",
        statusHistory: [
          {
            previousStatus: undefined,
            nextStatus: "created",
            reason: "run created",
            actor: AuditActor.System,
            createdAt: now,
          },
        ],
      },
    };
    await this.db.runs.create(run);
    await this.db.runStatusHistory.append({
      runId: input.runId,
      nextStatus: "created",
      reason: "run created",
      actor: AuditActor.System,
      createdAt: now,
    });
    return mapRunToState(run);
  }

  async markStatus(
    runId: string,
    nextStatus: AgentLoopStatus,
    reason?: string,
  ): Promise<RunState> {
    const run = await this.requireRun(runId);
    const currentStatus = run.status as AgentLoopStatus;
    if (currentStatus === nextStatus) return mapRunToState(run);

    // Terminal states cannot transition further — silently ignore
    if (isTerminal(currentStatus)) {
      console.warn(
        `[RepositoryRunStateManager] run ${runId} is already terminal (${currentStatus}), ignoring transition to ${nextStatus}`,
      );
      return mapRunToState(run);
    }

    const allowed = LEGAL_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes(nextStatus)) {
      throw Object.assign(
        new Error(
          `Illegal state transition: ${currentStatus} -> ${nextStatus} for run ${runId}`,
        ),
        { code: "AGENT_RUN_STATE_CONFLICT" },
      );
    }

    const now = new Date().toISOString();
    const statusHistory = truncateStatusHistory([
      ...statusHistoryFrom(run),
      {
        previousStatus: currentStatus,
        nextStatus,
        reason: reason ?? "state transition",
        actor: AuditActor.System,
        createdAt: now,
      },
    ]);

    // §B2: wrap the three writes in a single transaction so partial failures
    // cannot leave runs / context / history out of sync. Fall back to the
    // sequential path when the underlying database does not expose a
    // transaction helper.
    const writeAll = async (db: DatabaseContext): Promise<void> => {
      const statusUpdate = {
        status: nextStatus,
        updatedAt: now,
        ...(isTerminal(nextStatus) ? { completedAt: now } : {}),
        ...(nextStatus === "cancelled" ? { cancelledAt: now } : {}),
      };
      const updated = db.runs.updateStatusIfCurrent
        ? await db.runs.updateStatusIfCurrent(runId, currentStatus, statusUpdate)
        : (await db.runs.updateStatus(runId, statusUpdate), true);
      if (!updated) throw stateConflict(runId, currentStatus, nextStatus);
      const contextPatch = {
        agentStatus: nextStatus,
        statusHistory,
      };
      if (db.runs.patchContext) await db.runs.patchContext(runId, contextPatch);
      else await db.runs.updateContext(runId, { ...run.context, ...contextPatch });
      await db.runStatusHistory.append({
        runId,
        previousStatus: currentStatus,
        nextStatus,
        reason: reason ?? "state transition",
        actor: AuditActor.System,
        createdAt: now,
      });
    };

    if (this.db.transaction) {
      await this.db.transaction(writeAll);
    } else {
      await writeAll(this.db);
    }

    return mapRunToState((await this.requireRun(runId)));
  }

  async markFailed(runId: string, error: unknown): Promise<RunState> {
    const run = await this.requireRun(runId);
    const currentStatus = run.status as AgentLoopStatus;
    // §B11: never bypass the state machine — if the current status cannot
    // legally transition to `failed`, surface the conflict instead of
    // silently writing a terminal state.
    if (isTerminal(currentStatus)) {
      console.warn(
        `[RepositoryRunStateManager] run ${runId} is already terminal (${currentStatus}), ignoring markFailed`,
      );
      return mapRunToState(run);
    }
    const allowed = LEGAL_TRANSITIONS[currentStatus];
    if (!allowed || !allowed.includes("failed")) {
      throw Object.assign(
        new Error(
          `Illegal state transition: ${currentStatus} -> failed for run ${runId}`,
        ),
        { code: "AGENT_RUN_STATE_CONFLICT" },
      );
    }

    const err = error instanceof Error ? error : new Error(String(error));
    const agentError = {
      code: (error as { code?: string }).code ?? "AGENT_INTERNAL_ERROR",
      message: err.message,
      category: (error as { category?: string }).category ?? "internal",
      retryable: (error as { retryable?: boolean }).retryable ?? false,
    };
    const now = new Date().toISOString();
    const statusHistory = truncateStatusHistory([
      ...statusHistoryFrom(run),
      {
        previousStatus: currentStatus,
        nextStatus: "failed",
        reason: err.message,
        actor: AuditActor.System,
        createdAt: now,
      },
    ]);

    const writeAll = async (db: DatabaseContext): Promise<void> => {
      const statusUpdate = {
        status: "failed",
        updatedAt: now,
        completedAt: now,
        error: agentError,
      } as const;
      const updated = db.runs.updateStatusIfCurrent
        ? await db.runs.updateStatusIfCurrent(runId, currentStatus, statusUpdate)
        : (await db.runs.updateStatus(runId, statusUpdate), true);
      if (!updated) throw stateConflict(runId, currentStatus, "failed");
      const contextPatch = {
        agentStatus: "failed",
        statusHistory,
      };
      if (db.runs.patchContext) await db.runs.patchContext(runId, contextPatch);
      else await db.runs.updateContext(runId, { ...run.context, ...contextPatch });
      await db.runStatusHistory.append({
        runId,
        previousStatus: currentStatus,
        nextStatus: "failed",
        reason: err.message,
        actor: AuditActor.System,
        metadata: { error: agentError },
        createdAt: now,
      });
    };

    if (this.db.transaction) {
      await this.db.transaction(writeAll);
    } else {
      await writeAll(this.db);
    }

    return mapRunToState(await this.requireRun(runId));
  }

  async markCompleted(runId: string, _result: AgentLoopResult): Promise<RunState> {
    return this.markStatus(runId, "completed", "run completed");
  }

  async markCancelled(runId: string, reason?: string): Promise<RunState> {
    return this.markStatus(runId, "cancelled", reason ?? "user cancelled");
  }

  async acquireExecution(
    runId: string,
    expectedStatuses: AgentLoopStatus[],
  ): Promise<{ acquired: boolean; state: RunState }> {
    const run = await this.requireRun(runId);
    const currentStatus = run.status as AgentLoopStatus;

    if (!expectedStatuses.includes(currentStatus)) {
      return { acquired: false, state: mapRunToState(run) };
    }

    const now = new Date().toISOString();
    const statusHistory = truncateStatusHistory([
      ...statusHistoryFrom(run),
      {
        previousStatus: currentStatus,
        nextStatus: "running",
        reason: "acquireExecution",
        actor: AuditActor.System,
        createdAt: now,
      },
    ]);

    const writeAll = async (db: DatabaseContext): Promise<boolean> => {
      if (db.runs.updateStatusIfInSet) {
        const acquired = await db.runs.updateStatusIfInSet(
          runId,
          expectedStatuses,
          { status: "running", updatedAt: now },
        );
        if (!acquired) return false;
      } else {
        let acquired = false;
        for (const expected of expectedStatuses) {
          if (db.runs.updateStatusIfCurrent) {
            acquired = await db.runs.updateStatusIfCurrent(
              runId,
              expected,
              { status: "running", updatedAt: now },
            );
            if (acquired) break;
          }
        }
        if (!acquired) {
          const fresh = await db.runs.findById(runId);
          if (!fresh) throw unknownRun(runId);
          return false;
        }
      }
      const contextPatch = {
        agentStatus: "running",
        statusHistory,
      };
      if (db.runs.patchContext) await db.runs.patchContext(runId, contextPatch);
      else await db.runs.updateContext(runId, { ...run.context, ...contextPatch });
      await db.runStatusHistory.append({
        runId,
        previousStatus: currentStatus,
        nextStatus: "running",
        reason: "acquireExecution",
        actor: AuditActor.System,
        createdAt: now,
      });
      return true;
    };

    let acquired: boolean;
    if (this.db.transaction) {
      acquired = await this.db.transaction(writeAll);
    } else {
      acquired = await writeAll(this.db);
    }

    const freshRun = await this.requireRun(runId);
    return { acquired, state: mapRunToState(freshRun) };
  }

  async getRun(runId: string): Promise<RunState | undefined> {
    const run = await this.db.runs.findById(runId);
    return run ? mapRunToState(run) : undefined;
  }

  async saveTaskState(
    runId: string,
    taskState: NonNullable<RunState["taskState"]>,
  ): Promise<void> {
    const run = await this.db.runs.findById(runId);
    if (!run) throw unknownRun(runId);
    if (this.db.runs.patchContext) {
      await this.db.runs.patchContext(runId, { taskState });
    } else {
      await this.db.runs.updateContext(runId, { ...run.context, taskState });
    }
  }

  private async requireRun(runId: string): Promise<RunRecord> {
    const run = await this.db.runs.findById(runId);
    if (!run) {
      throw Object.assign(new Error(`Unknown run: ${runId}`), {
        code: "AGENT_RUN_NOT_FOUND",
      });
    }
    return run;
  }
}

function unknownRun(runId: string): Error {
  return Object.assign(new Error(`Unknown run: ${runId}`), {
    code: "AGENT_RUN_NOT_FOUND",
  });
}

function stateConflict(
  runId: string,
  expected: AgentLoopStatus,
  next: AgentLoopStatus,
): Error {
  return Object.assign(
    new Error(`Concurrent state transition conflict: expected ${expected} before ${next} for run ${runId}`),
    { code: "AGENT_RUN_STATE_CONFLICT" },
  );
}

function mapRunToState(run: RunRecord): RunState {
  const history = statusHistoryFrom(run);
  const lastTransition = history.at(-1);
  const taskState = run.context.taskState as RunState["taskState"] | undefined;
  return {
    runId: run.id,
    conversationId: run.conversationId ?? "",
    status: run.status as AgentLoopStatus,
    previousStatus: lastTransition?.previousStatus as AgentLoopStatus | undefined,
    mode: run.mode,
    goal: run.goal,
    input: normalizeInputSnapshot(run.input),
    error: normalizeError(run.error),
    taskState,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    cancelledAt: run.cancelledAt,
  };
}

function normalizeInputSnapshot(input: unknown): RunState["input"] {
  if (!input || typeof input !== "object") return undefined;
  const value = input as Partial<NonNullable<RunState["input"]>>;
  if (
    typeof value.message !== "string" ||
    !value.client ||
    (value.mode !== "chat" && value.mode !== "agent")
  ) {
    return undefined;
  }
  return {
    version: 1,
    message: value.message,
    attachments: Array.isArray(value.attachments) ? value.attachments : [],
    client: value.client,
    permissionMode: value.permissionMode ?? "auto",
    modelId: value.modelId,
    mode: value.mode,
    userMessageId: value.userMessageId ?? "",
  };
}

function statusHistoryFrom(run: RunRecord): Array<{
  previousStatus?: string;
  nextStatus: string;
  reason?: string;
  actor: string;
  createdAt: string;
}> {
  const value = run.context.statusHistory;
  return Array.isArray(value) ? value as ReturnType<typeof statusHistoryFrom> : [];
}

/** §B8: cap persisted status history to prevent unbounded growth. */
const MAX_STATUS_HISTORY = 1000;

function truncateStatusHistory<T extends Array<unknown>>(history: T): T {
  if (history.length <= MAX_STATUS_HISTORY) return history;
  // Keep the most recent entries — older transitions are still available via
  // the run_status_history table for the repository-backed manager.
  return history.slice(history.length - MAX_STATUS_HISTORY) as T;
}

function normalizeError(error: unknown): RunState["error"] {
  if (!error || typeof error !== "object") return undefined;
  const input = error as {
    code?: unknown;
    message?: unknown;
    category?: unknown;
    retryable?: unknown;
  };
  return {
    code: typeof input.code === "string" ? input.code : "AGENT_INTERNAL_ERROR",
    message: typeof input.message === "string" ? input.message : "Unknown error",
    category: typeof input.category === "string" ? input.category : undefined,
    retryable: typeof input.retryable === "boolean" ? input.retryable : undefined,
  };
}

function titleFromGoal(goal: string): string {
  const title = goal.trim().replace(/\s+/g, " ").slice(0, 80);
  return title || "Agent run";
}
