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
        message: input.message,
        attachments: input.attachments ?? [],
        client: input.client,
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
    await this.db.runs.updateStatus(runId, {
      status: nextStatus,
      updatedAt: now,
      ...(isTerminal(nextStatus) ? { completedAt: now } : {}),
    });
    await this.db.runs.updateContext(runId, {
      ...run.context,
      agentStatus: nextStatus,
      statusHistory: [
        ...statusHistoryFrom(run),
        {
          previousStatus: currentStatus,
          nextStatus,
          reason: reason ?? "state transition",
          actor: AuditActor.System,
          createdAt: now,
        },
      ],
    });
    await this.db.runStatusHistory.append({
      runId,
      previousStatus: currentStatus,
      nextStatus,
      reason: reason ?? "state transition",
      actor: AuditActor.System,
      createdAt: now,
    });

    return mapRunToState((await this.requireRun(runId)));
  }

  async markFailed(runId: string, error: unknown): Promise<RunState> {
    const run = await this.requireRun(runId);
    const err = error instanceof Error ? error : new Error(String(error));
    const agentError = {
      code: (error as { code?: string }).code ?? "AGENT_INTERNAL_ERROR",
      message: err.message,
      category: (error as { category?: string }).category ?? "internal",
      retryable: (error as { retryable?: boolean }).retryable ?? false,
    };
    const now = new Date().toISOString();

    await this.db.runs.updateStatus(runId, {
      status: "failed",
      updatedAt: now,
      completedAt: now,
      error: agentError,
    });
    await this.db.runs.updateContext(runId, {
      ...run.context,
      agentStatus: "failed",
      statusHistory: [
        ...statusHistoryFrom(run),
        {
          previousStatus: run.status,
          nextStatus: "failed",
          reason: err.message,
          actor: AuditActor.System,
          createdAt: now,
        },
      ],
    });
    await this.db.runStatusHistory.append({
      runId,
      previousStatus: run.status,
      nextStatus: "failed",
      reason: err.message,
      actor: AuditActor.System,
      metadata: { error: agentError },
      createdAt: now,
    });

    return mapRunToState(await this.requireRun(runId));
  }

  async markCompleted(runId: string, _result: AgentLoopResult): Promise<RunState> {
    return this.markStatus(runId, "completed", "run completed");
  }

  async markCancelled(runId: string, reason?: string): Promise<RunState> {
    return this.markStatus(runId, "cancelled", reason ?? "user cancelled");
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
    if (!run) return;
    await this.db.runs.updateContext(runId, {
      ...run.context,
      taskState,
    });
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
    error: normalizeError(run.error),
    taskState,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    cancelledAt: run.cancelledAt,
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
