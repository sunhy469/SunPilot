import type { RunRecord, RunStatus } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import {
  parseReactCheckpoint,
  RepositoryRunStateManager,
} from "@sunpilot/core";

const AGENT_RECOVERY_INTERRUPT_STATUSES: readonly RunStatus[] = [
  "running",
];

/**
 * Daemon 重启恢复扫描。
 *
 * 扫描所有处于"非终态"的 Run，根据状态分类处理：
 * - running → 标记为 interrupted（从持久化 ReAct checkpoint 恢复）
 * - waiting_approval 状态 → 重新发送审批事件，通知前端恢复审批 UI
 * - waiting_user 状态 → 保持等待，用户输入后从 checkpoint 恢复
 */
export async function recoverAgentRuntimeRuns(
  database: DatabaseContext,
): Promise<{
  recoveredRuns: string[];
  interruptedRuns: string[];
  failedRuns: string[];
  snapshottedApprovals: string[];
}> {
  const now = new Date().toISOString();
  const recoveredRuns: string[] = [];
  const interruptedRuns: string[] = [];
  const failedRuns: string[] = [];
  const snapshottedApprovals: string[] = [];

  for (const run of await listAllRuns(database, "created")) {
    await failRecoveredRun(
      database,
      run,
      Object.assign(
        new Error("Daemon restarted before the run entered execution."),
        { code: "AGENT_RECOVERY_NOT_STARTED" },
      ),
      now,
    );
    recoveredRuns.push(run.id);
    failedRuns.push(run.id);
  }

  for (const status of AGENT_RECOVERY_INTERRUPT_STATUSES) {
    for (const run of await listAllRuns(database, status)) {
      try {
        await interruptRecoveredRun(database, run, now);
        interruptedRuns.push(run.id);
      } catch (error) {
        await failRecoveredRun(database, run, error, now);
        failedRuns.push(run.id);
      }
      recoveredRuns.push(run.id);
    }
  }

  for (const run of await listAllRuns(database, "waiting_approval")) {
    const approvals = await database.approvals.list({
      runId: run.id,
      status: "pending",
      limit: 200,
    });
    for (const approval of approvals) {
      await database.events.append({
        id: `evt_${crypto.randomUUID()}`,
        runId: run.id,
        conversationId: run.conversationId,
        type: "agent.approval.required",
        payload: {
          runId: run.id,
          approvalId: approval.id,
          title: approval.title,
          riskLevel: approval.risk,
          recovered: true,
        },
        createdAt: now,
      });
      snapshottedApprovals.push(approval.id);
    }
    if (approvals.length > 0) {
      recoveredRuns.push(run.id);
    } else {
      await failRecoveredRun(
        database,
        run,
        Object.assign(
          new Error("Waiting approval run has no pending approval record."),
          { code: "AGENT_RECOVERY_APPROVAL_MISSING" },
        ),
        now,
      );
      recoveredRuns.push(run.id);
      failedRuns.push(run.id);
    }
  }

  for (const run of await listAllRuns(database, "waiting_user")) {
    if (hasReactCheckpoint(run)) {
      recoveredRuns.push(run.id);
      continue;
    }
    await failRecoveredRun(
      database,
      run,
      Object.assign(
        new Error("Waiting user run has no resumable ReAct checkpoint."),
        { code: "AGENT_RECOVERY_CHECKPOINT_MISSING" },
      ),
      now,
    );
    recoveredRuns.push(run.id);
    failedRuns.push(run.id);
  }

  if (
    recoveredRuns.length > 0 ||
    interruptedRuns.length > 0 ||
    failedRuns.length > 0 ||
    snapshottedApprovals.length > 0
  ) {
    await database.audit.create({
      runId: undefined,
      actor: "daemon",
      action: "daemon.recovery_scan",
      target: "agent-runtime",
      payload: {
        recoveredRuns,
        interruptedRuns,
        failedRuns,
        snapshottedApprovals,
      },
      createdAt: now,
    });
  }

  return { recoveredRuns, interruptedRuns, failedRuns, snapshottedApprovals };
}

async function interruptRecoveredRun(
  database: DatabaseContext,
  run: RunRecord,
  now: string,
): Promise<void> {
  const error = {
    code: "AGENT_RUN_INTERRUPTED",
    message: "Daemon restarted while the run was unfinished.",
    category: "run_state",
    retryable: true,
  };
  const work = async (db: DatabaseContext): Promise<void> => {
    const states = new RepositoryRunStateManager(db);
    await states.markStatus(
      run.id,
      "interrupted",
      "daemon restarted while run was unfinished",
    );
    // Preserve a structured retryable error alongside the legal state change.
    await db.runs.updateStatus(run.id, { status: "interrupted", updatedAt: now, error });
    for (const step of await db.steps.listByRunId(run.id)) {
      if (["pending", "running", "waiting_approval"].includes(step.status)) {
        await db.steps.updateStatus(step.id, "interrupted", undefined, {
          reason: "daemon restarted while run was unfinished",
        });
      }
    }
    await db.events.append({
      id: `evt_${crypto.randomUUID()}`,
      runId: run.id,
      conversationId: run.conversationId,
      type: "agent.run.interrupted",
      payload: { runId: run.id, error },
      createdAt: now,
    });
  };
  if (database.transaction) await database.transaction(work);
  else await work(database);
}

async function failRecoveredRun(
  database: DatabaseContext,
  run: RunRecord,
  cause: unknown,
  now: string,
): Promise<void> {
  const code = (cause as { code?: string } | undefined)?.code ?? "AGENT_RECOVERY_FAILED";
  const error = Object.assign(
    new Error(
      `Daemon could not safely interrupt unfinished run: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    ),
    { code, category: "run_state", retryable: true },
  );
  const states = new RepositoryRunStateManager(database);
  await states.markFailed(run.id, error);
  await database.events.append({
    id: `evt_${crypto.randomUUID()}`,
    runId: run.id,
    conversationId: run.conversationId,
    type: "agent.run.failed",
    payload: {
      runId: run.id,
      error: {
        code,
        message: error.message,
        category: "run_state",
        retryable: true,
      },
    },
    createdAt: now,
  });
}

async function listAllRuns(
  database: DatabaseContext,
  status: RunStatus,
): Promise<RunRecord[]> {
  const runs: RunRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await database.runs.list({ status, limit: 200, cursor });
    runs.push(...page);
    const last = page.at(-1);
    cursor = page.length === 200 && last
      ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString("base64url")
      : undefined;
  } while (cursor);
  return runs;
}

function hasReactCheckpoint(run: RunRecord): boolean {
  const taskState = run.context.taskState;
  if (!taskState || typeof taskState !== "object" || Array.isArray(taskState)) {
    return false;
  }
  const gatheredFacts = (taskState as { gatheredFacts?: unknown }).gatheredFacts;
  if (!gatheredFacts || typeof gatheredFacts !== "object" || Array.isArray(gatheredFacts)) {
    return false;
  }
  return !!parseReactCheckpoint(
    (gatheredFacts as { reactCheckpoint?: unknown }).reactCheckpoint,
  );
}
