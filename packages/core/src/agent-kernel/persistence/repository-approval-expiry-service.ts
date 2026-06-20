import { AuditActor, type ApprovalRecord } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type { AgentEventBus } from "../agent-event-bus.js";
import { RUN_PHASE_LABELS } from "../agent-loop-engine.js";
import { RepositoryRunStateManager } from "./repository-run-state-manager.js";

export interface ExpiredApprovalResult {
  approvalId: string;
  runId: string;
  runCancelled: boolean;
}

export class RepositoryApprovalExpiryService {
  private readonly runStateManager: RepositoryRunStateManager;

  constructor(
    private readonly db: DatabaseContext,
    private readonly eventBus?: AgentEventBus,
  ) {
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
        actor: AuditActor.Daemon,
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

      // §P0-3: Update the original "等待确认" status part to failed
      if (this.eventBus) {
        const runState = await this.runStateManager.getRun(expired.runId);
        const gatheredFacts = runState?.taskState?.gatheredFacts as Record<string, unknown> | undefined;
        const partsSnapshot = gatheredFacts?.partsSnapshot as Array<{ id: string; type: string; status?: string; label?: string }> | undefined;
        const approvalMessageId = gatheredFacts?.approvalMessageId as string | undefined;
        if (approvalMessageId && partsSnapshot) {
          for (const part of partsSnapshot) {
            if (part.type === "status" && part.status === "running" && part.label?.startsWith(RUN_PHASE_LABELS.waiting_approval)) {
              this.eventBus.emit(
                "agent.message.part.updated",
                {
                  runId: expired.runId,
                  conversationId: run?.conversationId,
                  messageId: approvalMessageId,
                  partId: part.id,
                  patch: {
                    status: "failed",
                    label: `确认已过期: ${part.label.replace(`${RUN_PHASE_LABELS.waiting_approval}: `, "")}`,
                  },
                },
                { runId: expired.runId, conversationId: run?.conversationId },
              );
            }
          }
        }
      }

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
