import type { ApprovalRecord } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type { AgentEvent } from "../agent-event-bus.js";
import type { RiskLevel } from "../loop-types.js";
import {
  normalizeRequestedAction,
  type NormalizedApprovalAction,
} from "./approval-action.js";

export interface ApprovalDecisionResult {
  approvalId: string;
  runId: string;
  decidedBy?: string;
  reason?: string;
  title?: string;
  riskLevel?: RiskLevel;
  requestedAction?: NormalizedApprovalAction;
  event: AgentEvent;
}

export class RepositoryApprovalDecisionService {
  constructor(private readonly db: DatabaseContext) {}

  approve(
    approvalId: string,
    decidedBy?: string,
  ): Promise<ApprovalDecisionResult> {
    return this.decide(approvalId, "approved", decidedBy);
  }

  reject(
    approvalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<ApprovalDecisionResult> {
    return this.decide(approvalId, "rejected", decidedBy, reason);
  }

  private async decide(
    approvalId: string,
    status: "approved" | "rejected",
    decidedBy?: string,
    reason?: string,
  ): Promise<ApprovalDecisionResult> {
    const work = async (database: DatabaseContext) => {
      const approval = await requirePendingApproval(database, approvalId);
      const decided = await database.approvals.decide(approvalId, status, {
        decidedBy,
        reason,
      });
      if (!decided || decided.status !== status) {
        throw Object.assign(
          new Error(`Approval is already decided: ${approvalId}`),
          { code: "AGENT_APPROVAL_ALREADY_DECIDED" },
        );
      }
      const run = await database.runs.findById(decided.runId);
      const eventType =
        status === "approved"
          ? "agent.approval.approved"
          : "agent.approval.rejected";
      const now = new Date().toISOString();

      await database.audit.create({
        runId: decided.runId,
        stepId: decided.stepId,
        actor: decidedBy ?? "user",
        action: `approval.${status}`,
        target: approvalId,
        risk: decided.risk,
        payload: {
          approvalId,
          title: decided.title,
          reason,
          requestedAction: decided.requestedAction,
        },
        createdAt: now,
      });

      const event: AgentEvent = {
        id: `evt_${crypto.randomUUID()}`,
        type: eventType,
        runId: decided.runId,
        conversationId: run?.conversationId,
        payload: {
          runId: decided.runId,
          approvalId,
          decidedBy,
          ...(reason ? { reason } : {}),
        },
        createdAt: now,
      };
      const persisted = await database.events.append({
        id: event.id,
        runId: decided.runId,
        conversationId: run?.conversationId,
        type: event.type,
        payload: event.payload,
        createdAt: now,
      });

      return {
        approvalId,
        runId: decided.runId,
        decidedBy,
        reason,
        title: decided.title,
        riskLevel: decided.risk as RiskLevel,
        requestedAction: normalizeRequestedAction(decided.requestedAction),
        event: {
          ...event,
          sequence: persisted.sequence,
        },
      };
    };

    return this.db.transaction ? this.db.transaction(work) : work(this.db);
  }
}

async function requirePendingApproval(
  database: DatabaseContext,
  approvalId: string,
): Promise<ApprovalRecord> {
  const approval = await database.approvals.findById(approvalId);
  if (!approval) {
    throw Object.assign(new Error(`Unknown approval: ${approvalId}`), {
      code: "AGENT_APPROVAL_REQUIRED",
    });
  }
  if (approval.status !== "pending") {
    throw Object.assign(
      new Error(`Approval is already ${approval.status}: ${approvalId}`),
      { code: "AGENT_APPROVAL_ALREADY_DECIDED" },
    );
  }
  return approval;
}
