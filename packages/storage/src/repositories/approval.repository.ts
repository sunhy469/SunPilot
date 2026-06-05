import type { ApprovalRecord } from "@sunpilot/protocol";

export interface ApprovalRepository {
  create(input: ApprovalRecord): Promise<ApprovalRecord>;
  decide(id: string, status: "approved" | "rejected", decision: unknown): Promise<ApprovalRecord | null>;
  findById(id: string): Promise<ApprovalRecord | null>;
  list(): Promise<ApprovalRecord[]>;
}
