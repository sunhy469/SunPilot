import type { RunRecord, RunStatus } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";

const AGENT_RECOVERY_INTERRUPT_STATUSES: readonly RunStatus[] = [
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "executing",
  "observing",
  "reflecting",
];

/**
 * Daemon 重启恢复扫描。
 *
 * 扫描所有处于"非终态"的 Run，根据状态分类处理：
 * - 中间状态（context_building 等）→ 标记为 interrupted（用户可 resume）
 * - responding 状态 → 标记为 failed（响应生成中途中断，不可安全续接）
 * - waiting_approval 状态 → 重新发送审批事件，通知前端恢复审批 UI
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

  for (const status of AGENT_RECOVERY_INTERRUPT_STATUSES) {
    for (const run of await database.runs.list({ status, limit: 200 })) {
      await interruptRecoveredRun(database, run, now);
      recoveredRuns.push(run.id);
      interruptedRuns.push(run.id);
    }
  }

  for (const run of await database.runs.list({
    status: "responding",
    limit: 200,
  })) {
    const error = {
      code: "AGENT_RUN_RECOVERY_REQUIRED",
      message: "Daemon restarted while the run was responding.",
      category: "run_state",
      retryable: true,
    };
    await database.runs.updateStatus(run.id, { status: "failed", updatedAt: now, error });
    await database.runStatusHistory.append({
      runId: run.id,
      previousStatus: run.status,
      nextStatus: "failed",
      reason: "daemon restarted during response generation",
      actor: "daemon",
      createdAt: now,
    });
    await database.events.append({
      id: `evt_${crypto.randomUUID()}`,
      runId: run.id,
      conversationId: run.conversationId,
      type: "agent.run.failed",
      payload: { runId: run.id, error },
      createdAt: now,
    });
    recoveredRuns.push(run.id);
    failedRuns.push(run.id);
  }

  for (const run of await database.runs.list({
    status: "waiting_approval",
    limit: 200,
  })) {
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
    if (approvals.length > 0) recoveredRuns.push(run.id);
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
  await database.runs.updateStatus(run.id, { status: "interrupted", updatedAt: now, error });
  await database.runStatusHistory.append({
    runId: run.id,
    previousStatus: run.status,
    nextStatus: "interrupted",
    reason: "daemon restarted while run was unfinished",
    actor: "daemon",
    createdAt: now,
  });
  for (const step of await database.steps.listByRunId(run.id)) {
    if (["pending", "running", "waiting_approval"].includes(step.status)) {
      await database.steps.updateStatus(step.id, "interrupted", undefined, {
        reason: "daemon restarted while run was unfinished",
      });
    }
  }
  try {
    await (database as any).jobs?.updateStatus?.(run.id, "interrupted");
  } catch {
    // jobs repository not yet available on DatabaseContext; skip during recovery
  }
  await database.events.append({
    id: `evt_${crypto.randomUUID()}`,
    runId: run.id,
    conversationId: run.conversationId,
    type: "agent.run.interrupted",
    payload: { runId: run.id, error },
    createdAt: now,
  });
}
