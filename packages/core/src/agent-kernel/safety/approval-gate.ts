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
  /** §B9: pending cleanup timers for decided approvals, keyed by approval id. */
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** §B9: how long to keep a decided approval before evicting it (30 min). */
  private static readonly DECIDED_RETENTION_MS = 30 * 60 * 1000;

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
      // §B29: AGENT_APPROVAL_REQUIRED is for "this action needs approval" —
      // a missing record is a NOT_FOUND. Use the dedicated error code.
      throw Object.assign(new Error(`Unknown approval: ${approvalId}`), {
        code: "AGENT_APPROVAL_NOT_FOUND",
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
    // §B9: schedule eviction so decided approvals don't accumulate forever.
    this.scheduleCleanup(approvalId);
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
      // §B29: same as approve() — missing record is NOT_FOUND.
      throw Object.assign(new Error(`Unknown approval: ${approvalId}`), {
        code: "AGENT_APPROVAL_NOT_FOUND",
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
    // §B9: schedule eviction so decided approvals don't accumulate forever.
    this.scheduleCleanup(approvalId);
    return { approvalId, runId: approval.runId, decidedBy, reason };
  }

  /**
   * §B9: schedule eviction of a decided approval after the retention window.
   * Uses unref() (when available) so the timer does not keep the Node.js
   * event loop alive in tests or short-lived processes.
   */
  private scheduleCleanup(approvalId: string): void {
    // Clear any previously scheduled timer (e.g. re-decision edge case).
    const existing = this.cleanupTimers.get(approvalId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.approvals.delete(approvalId);
      this.cleanupTimers.delete(approvalId);
    }, InMemoryApprovalGate.DECIDED_RETENTION_MS);
    // unref is only available in Node.js, not browsers — guard for safety.
    if (typeof timer === "object" && timer && typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    this.cleanupTimers.set(approvalId, timer);
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
