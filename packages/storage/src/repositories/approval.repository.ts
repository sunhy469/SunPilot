import type { ApprovalRecord } from "@sunpilot/protocol";

export interface ListApprovalsInput {
  status?: ApprovalRecord["status"];
  runId?: string;
  limit?: number;
}

export interface ApprovalRepository {
  create(input: ApprovalRecord): Promise<ApprovalRecord>;
  decide(id: string, status: "approved" | "rejected", decision: unknown): Promise<ApprovalRecord | null>;
  expire(id: string): Promise<ApprovalRecord | null>;
  findById(id: string): Promise<ApprovalRecord | null>;
  list(input?: ListApprovalsInput): Promise<ApprovalRecord[]>;
}
