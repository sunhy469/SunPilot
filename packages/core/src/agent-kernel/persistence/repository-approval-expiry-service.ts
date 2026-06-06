import type { ApprovalRecord } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import { RepositoryRunStateManager } from "./repository-run-state-manager.js";

export interface ExpiredApprovalResult {
  approvalId: string;
  runId: string;
  runCancelled: boolean;
}

export class RepositoryApprovalExpiryService {
  private readonly runStateManager: RepositoryRunStateManager;

  constructor(private readonly db: DatabaseContext) {
    this.runStateManager = new RepositoryRunStateManager(db);
  }

  async expireStale(
    now = new Date().toISOString(),
  ): Promise<ExpiredApprovalResult[]> {
    const pending = await this.db.approvals.list({ status: "pending" });
    const stale = pending.filter((approval) => isExpired(approval, now));
    const results: ExpiredApprovalResult[] = [];

    for (const approval of stale) {
      const expired = await this.db.approvals.expire(approval.id);
      if (!expired || expired.status !== "expired") continue;

      let runCancelled = false;
      const run = await this.db.runs.findById(expired.runId);
      if (run?.status === "waiting_approval") {
        await this.runStateManager.markCancelled(
          expired.runId,
          `approval expired: ${expired.id}`,
        );
        runCancelled = true;
      }

      await this.db.audit.create({
        runId: expired.runId,
        stepId: expired.stepId,
        actor: "daemon",
        action: "approval.expired",
        target: expired.id,
        risk: expired.risk,
        payload: {
          approvalId: expired.id,
          title: expired.title,
          expiresAt: expired.expiresAt,
        },
        createdAt: now,
      });

      await this.db.events.append({
        id: `evt_${crypto.randomUUID()}`,
        runId: expired.runId,
        conversationId: run?.conversationId,
        type: "agent.approval.expired",
        payload: {
          runId: expired.runId,
          approvalId: expired.id,
          title: expired.title,
          riskLevel: expired.risk,
          runCancelled,
        },
        createdAt: now,
      });

      if (runCancelled) {
        await this.db.events.append({
          id: `evt_${crypto.randomUUID()}`,
          runId: expired.runId,
          conversationId: run?.conversationId,
          type: "agent.run.cancelled",
          payload: {
            runId: expired.runId,
            reason: `approval expired: ${expired.id}`,
          },
          createdAt: now,
        });
      }

      results.push({
        approvalId: expired.id,
        runId: expired.runId,
        runCancelled,
      });
    }

    return results;
  }
}

function isExpired(approval: ApprovalRecord, now: string): boolean {
  return !!approval.expiresAt && new Date(approval.expiresAt) <= new Date(now);
}
