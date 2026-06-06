import type { RunRecord } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type {
  AgentLoopInput,
  AgentLoopResult,
  AgentLoopStatus,
} from "../loop-types.js";
import type { RunState, RunStateManager } from "../run-state-manager.js";

const LEGAL_TRANSITIONS: Record<AgentLoopStatus, readonly AgentLoopStatus[]> = {
  created: ["context_building", "cancelled", "failed"],
  context_building: ["intent_routing", "cancelled", "failed"],
  intent_routing: ["planning", "tool_deciding", "responding", "cancelled", "failed"],
  planning: ["tool_deciding", "waiting_approval", "cancelled", "failed"],
  tool_deciding: ["waiting_approval", "executing", "responding", "cancelled", "failed"],
  waiting_approval: ["executing", "cancelled", "failed"],
  executing: ["observing", "reflecting", "responding", "waiting_approval", "cancelled", "failed"],
  observing: ["reflecting", "responding", "cancelled", "failed"],
  reflecting: ["tool_deciding", "responding", "cancelled", "failed"],
  responding: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

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
            actor: "system",
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
      actor: "system",
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
    await this.db.runs.updateStatus(
      runId,
      nextStatus,
      isTerminal(nextStatus) ? now : undefined,
    );
    await this.db.runs.updateContext(runId, {
      ...run.context,
      agentStatus: nextStatus,
      statusHistory: [
        ...statusHistoryFrom(run),
        {
          previousStatus: currentStatus,
          nextStatus,
          reason: reason ?? "state transition",
          actor: "system",
          createdAt: now,
        },
      ],
    });
    await this.db.runStatusHistory.append({
      runId,
      previousStatus: currentStatus,
      nextStatus,
      reason: reason ?? "state transition",
      actor: "system",
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

    await this.db.runs.updateStatus(runId, "failed", now, agentError);
    await this.db.runs.updateContext(runId, {
      ...run.context,
      agentStatus: "failed",
      statusHistory: [
        ...statusHistoryFrom(run),
        {
          previousStatus: run.status,
          nextStatus: "failed",
          reason: err.message,
          actor: "system",
          createdAt: now,
        },
      ],
    });
    await this.db.runStatusHistory.append({
      runId,
      previousStatus: run.status,
      nextStatus: "failed",
      reason: err.message,
      actor: "system",
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
  return {
    runId: run.id,
    conversationId: run.conversationId ?? "",
    status: run.status as AgentLoopStatus,
    previousStatus: lastTransition?.previousStatus as AgentLoopStatus | undefined,
    mode: run.mode,
    goal: run.goal,
    error: normalizeError(run.error),
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

function isTerminal(status: AgentLoopStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function titleFromGoal(goal: string): string {
  const title = goal.trim().replace(/\s+/g, " ").slice(0, 80);
  return title || "Agent run";
}
