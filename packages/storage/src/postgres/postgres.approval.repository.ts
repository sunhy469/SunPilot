import type { ApprovalRecord } from "@sunpilot/protocol";
import type { ApprovalRepository } from "../repositories/approval.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresApprovalRepository implements ApprovalRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: ApprovalRecord): Promise<ApprovalRecord> {
    const result = await this.pool.query(
      `INSERT INTO approvals (id, run_id, step_id, status, risk, title, reason, requested_action, decision, created_at, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)
       RETURNING id, run_id, step_id, status, risk, title, reason, requested_action, decision, created_at, decided_at`,
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
        input.decidedAt ?? null
      ]
    );
    return mapApproval(result.rows[0]);
  }

  async decide(id: string, status: "approved" | "rejected", decision: unknown): Promise<ApprovalRecord | null> {
    const result = await this.pool.query(
      `UPDATE approvals
       SET status = $1, decision = $2::jsonb, decided_at = NOW()
       WHERE id = $3 AND status = 'pending'
       RETURNING id, run_id, step_id, status, risk, title, reason, requested_action, decision, created_at, decided_at`,
      [status, JSON.stringify(decision ?? null), id]
    );
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  async findById(id: string): Promise<ApprovalRecord | null> {
    const result = await this.pool.query("SELECT id, run_id, step_id, status, risk, title, reason, requested_action, decision, created_at, decided_at FROM approvals WHERE id = $1", [id]);
    return result.rows[0] ? mapApproval(result.rows[0]) : null;
  }

  async list(): Promise<ApprovalRecord[]> {
    const result = await this.pool.query("SELECT id, run_id, step_id, status, risk, title, reason, requested_action, decision, created_at, decided_at FROM approvals ORDER BY created_at DESC");
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
    decidedAt: row.decided_at?.toISOString()
  };
}
