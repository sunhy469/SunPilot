import type { ApprovalGate as ApprovalGateInterface } from "../loop-types.js";
import {
  APPROVAL_EXPIRY_MINUTES,
  type ApprovalRequest,
  type Permission,
} from "./safety-types.js";

/**
 * In-memory ApprovalGate for MVP.
 * Phase 6 will add PostgreSQL-backed persistence via the approvals table.
 */
export class InMemoryApprovalGate implements ApprovalGateInterface {
  private approvals = new Map<string, ApprovalRequest>();

  async createApproval(input: {
    runId: string;
    stepId?: string;
    toolCallId?: string;
    title: string;
    description: string;
    riskLevel: "low" | "medium" | "high" | "critical";
    requestedAction: {
      skillId: string;
      arguments: Record<string, unknown>;
      permissions: Permission[];
    };
  }): Promise<{ id: string; status: string }> {
    const id = `approval_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const expiryMinutes = APPROVAL_EXPIRY_MINUTES[input.riskLevel] ?? 30;

    const approval: ApprovalRequest = {
      id,
      runId: input.runId,
      stepId: input.stepId,
      toolCallId: input.toolCallId,
      title: input.title,
      description: input.description,
      riskLevel: input.riskLevel,
      requestedAction: input.requestedAction,
      status: "pending",
      createdAt: now,
      expiresAt:
        expiryMinutes > 0
          ? new Date(Date.now() + expiryMinutes * 60_000).toISOString()
          : undefined,
    };

    this.approvals.set(id, approval);
    return { id, status: "pending" };
  }

  async approve(
    approvalId: string,
    decidedBy?: string,
  ): Promise<{
    approvalId: string;
    runId: string;
    decidedBy?: string;
    title?: string;
    riskLevel?: "low" | "medium" | "high" | "critical";
    requestedAction?: {
      skillId: string;
      arguments: Record<string, unknown>;
      permissions: Permission[];
      toolCallId?: string;
    };
  }> {
    const approval = this.approvals.get(approvalId);
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

    approval.status = "approved";
    approval.decidedBy = decidedBy;
    approval.decidedAt = new Date().toISOString();
    this.approvals.set(approvalId, approval);
    return {
      approvalId,
      runId: approval.runId,
      decidedBy,
      title: approval.title,
      riskLevel: approval.riskLevel,
      requestedAction: {
        ...approval.requestedAction,
        toolCallId: approval.toolCallId,
      },
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
    const approval = this.approvals.get(approvalId);
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

    approval.status = "rejected";
    approval.decidedBy = decidedBy;
    approval.decidedAt = new Date().toISOString();
    approval.description = reason
      ? `${approval.description} (rejected: ${reason})`
      : approval.description;
    this.approvals.set(approvalId, approval);
    return { approvalId, runId: approval.runId, decidedBy, reason };
  }

  /** Get all pending approvals (for daemon/UI polling). */
  listPending(): ApprovalRequest[] {
    return [...this.approvals.values()].filter((a) => a.status === "pending");
  }

  /** Expire all approvals past their expiry time. Returns expired ids. */
  expireStale(): string[] {
    const now = new Date();
    const expired: string[] = [];
    for (const [id, approval] of this.approvals) {
      if (
        approval.status === "pending" &&
        approval.expiresAt &&
        new Date(approval.expiresAt) < now
      ) {
        approval.status = "expired";
        this.approvals.set(id, approval);
        expired.push(id);
      }
    }
    return expired;
  }
}
