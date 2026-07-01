import type { ApprovalRecord } from "@sunpilot/protocol";

export interface ListApprovalsInput {
  status?: ApprovalRecord["status"];
  runId?: string;
  limit?: number;
  /** Return only approvals whose expiry timestamp is at or before this instant. */
  expiresBefore?: string;
}

export interface ApprovalRepository {
  create(input: ApprovalRecord): Promise<ApprovalRecord>;
  decide(id: string, status: "approved" | "rejected", decision: unknown): Promise<ApprovalRecord | null>;
  expire(id: string): Promise<ApprovalRecord | null>;
  findById(id: string): Promise<ApprovalRecord | null>;
  list(input?: ListApprovalsInput): Promise<ApprovalRecord[]>;
}
