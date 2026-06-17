import type { ApprovalRecord } from "@sunpilot/protocol";
import type { ApprovalRepository, ListApprovalsInput } from "../repositories/approval.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresApprovalRepository implements ApprovalRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: ApprovalRecord): Promise<ApprovalRecord> {
    const result = await this.pool.query(
      `INSERT INTO approvals (
         id, run_id, step_id, status, risk, title, reason, requested_action,
         decision, created_at, expires_at, decided_by, decided_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
       RETURNING id, run_id, step_id, status, risk, title, reason, requested_action,
         decision, created_at, expires_at, decided_by, decided_at`,
      [
        input.id,
        input.runId,
        input.stepId ?? null,
        input.status,
        input.risk,
        input.title,
        input.reason,
        JSON.stringify(input.requestedAction ?? null),
        input.decision === undefined ? null : JSON.stringify(input.decision),
        input.createdAt,
        input.expiresAt ?? null,
        input.decidedBy ?? null,
        input.decidedAt ?? null
      ]
    );
    return mapApproval(result.rows[0]);
  }

  async decide(id: string, status: "approved" | "rejected", decision: unknown): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `UPDATE approvals
       SET status = $1,
           decision = $2::jsonb,
           decided_by = COALESCE($3, decided_by),
           decided_at = NOW()
       WHERE id = $4 AND status = 'pending'
       RETURNING id, run_id, step_id, status, risk, title, reason, requested_action,
         decision, created_at, expires_at, decided_by, decided_at`,
      [status, JSON.stringify(decision ?? null), extractDecidedBy(decision), id]
    );
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  async expire(id: string): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `UPDATE approvals
       SET status = 'expired'
       WHERE id = $1 AND status = 'pending'
       RETURNING id, run_id, step_id, status, risk, title, reason, requested_action,
         decision, created_at, expires_at, decided_by, decided_at`,
      [id]
    );
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  async findById(id: string): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `SELECT id, run_id, step_id, status, risk, title, reason, requested_action,
         decision, created_at, expires_at, decided_by, decided_at
       FROM approvals WHERE id = $1`,
      [id]
    );
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  async list(input: ListApprovalsInput = {}): Promise<ApprovalRecord[]> {
    const limit = Math.max(1, Math.min(Number(input.limit ?? 50), 200));
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.status) {
      values.push(input.status);
      conditions.push(`status = $${values.length}`);
    }
    if (input.runId) {
      values.push(input.runId);
      conditions.push(`run_id = $${values.length}`);
    }
    values.push(limit);
    const result = await this.pool.query(
      `SELECT id, run_id, step_id, status, risk, title, reason, requested_action,
         decision, created_at, expires_at, decided_by, decided_at
       FROM approvals
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map(mapApproval);
  }
}

function mapApproval(row: any): ApprovalRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    status: row.status,
    risk: row.risk,
    title: row.title,
    reason: row.reason,
    requestedAction: row.requested_action,
    decision: row.decision ?? undefined,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString(),
    decidedBy: row.decided_by ?? undefined,
    decidedAt: row.decided_at?.toISOString()
  };
}

function extractDecidedBy(decision: unknown): string | null {
  if (!decision || typeof decision !== "object") return null;
  const decidedBy = (decision as { decidedBy?: unknown }).decidedBy;
  return typeof decidedBy === "string" ? decidedBy : null;
}
