import type { ApprovalRecord } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type { ApprovalGate as ApprovalGateInterface } from "../loop-types.js";
import {
  APPROVAL_EXPIRY_MINUTES,
  type Permission,
} from "../safety/safety-types.js";
import { normalizeRequestedAction } from "./approval-action.js";

type RiskLevel = "low" | "medium" | "high" | "critical";

export class RepositoryApprovalGate implements ApprovalGateInterface {
  constructor(private readonly db: DatabaseContext) {}

  async createApproval(input: {
    runId: string;
    stepId?: string;
    toolCallId?: string;
    title: string;
    description: string;
    riskLevel: RiskLevel;
    requestedAction: {
      skillId: string;
      arguments: Record<string, unknown>;
      permissions: Permission[];
    };
  }): Promise<{ id: string; status: string }> {
    const now = new Date().toISOString();
    const expiryMinutes = APPROVAL_EXPIRY_MINUTES[input.riskLevel] ?? 30;
    const approval: ApprovalRecord = {
      id: `approval_${crypto.randomUUID()}`,
      runId: input.runId,
      stepId: input.stepId,
      status: "pending",
      risk: input.riskLevel,
      title: input.title,
      reason: input.description,
      requestedAction: {
        ...input.requestedAction,
        toolCallId: input.toolCallId,
      },
      createdAt: now,
      expiresAt:
        expiryMinutes > 0
          ? new Date(Date.now() + expiryMinutes * 60_000).toISOString()
          : undefined,
    };
    const created = await this.db.approvals.create(approval);
    return { id: created.id, status: created.status };
  }

  async approve(
    approvalId: string,
    decidedBy?: string,
  ): Promise<{
    approvalId: string;
    runId: string;
    decidedBy?: string;
    title?: string;
    riskLevel?: RiskLevel;
    requestedAction?: {
      skillId: string;
      arguments: Record<string, unknown>;
      permissions: Permission[];
      toolCallId?: string;
    };
  }> {
    const approval = await this.requirePendingApproval(approvalId);
    const decided = await this.db.approvals.decide(approvalId, "approved", {
      decidedBy,
    });
    await this.db.audit.create({
      runId: decided?.runId ?? approval.runId,
      stepId: approval.stepId,
      actor: decidedBy ?? "user",
      action: "approval.approved",
      target: approvalId,
      risk: approval.risk,
      payload: {
        approvalId,
        title: approval.title,
        requestedAction: approval.requestedAction,
      },
    });
    const requestedAction = normalizeRequestedAction(approval.requestedAction);
    return {
      approvalId,
      runId: decided?.runId ?? approval.runId,
      decidedBy,
      title: approval.title,
      riskLevel: approval.risk,
      requestedAction,
    };
  }

  async reject(
    approvalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<{
    approvalId: string;
    runId: string;
    decidedBy?: string;
    reason?: string;
  }> {
    const approval = await this.requirePendingApproval(approvalId);
    const decided = await this.db.approvals.decide(approvalId, "rejected", {
      decidedBy,
      reason,
    });
    await this.db.audit.create({
      runId: decided?.runId ?? approval.runId,
      stepId: approval.stepId,
      actor: decidedBy ?? "user",
      action: "approval.rejected",
      target: approvalId,
      risk: approval.risk,
      payload: {
        approvalId,
        title: approval.title,
        reason,
        requestedAction: approval.requestedAction,
      },
    });
    return {
      approvalId,
      runId: decided?.runId ?? approval.runId,
      decidedBy,
      reason,
    };
  }

  private async requirePendingApproval(
    approvalId: string,
  ): Promise<ApprovalRecord> {
    const approval = await this.requireApproval(approvalId);
    if (approval.status !== "pending") {
      throw Object.assign(
        new Error(`Approval is already ${approval.status}: ${approvalId}`),
        { code: "AGENT_APPROVAL_ALREADY_DECIDED" },
      );
    }
    return approval;
  }

  private async requireApproval(approvalId: string): Promise<ApprovalRecord> {
    const approval = await this.db.approvals.findById(approvalId);
    if (!approval) {
      throw Object.assign(new Error(`Unknown approval: ${approvalId}`), {
        code: "AGENT_APPROVAL_REQUIRED",
      });
    }
    return approval;
  }
}
