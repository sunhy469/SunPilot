import type { AuditRecord, AuditRepository, CreateAuditInput } from "../repositories/audit.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresAuditRepository implements AuditRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateAuditInput): Promise<AuditRecord> {
    const result = await this.pool.query(
      `INSERT INTO audit_logs (id, run_id, step_id, actor, action, target, risk, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING id, run_id, step_id, actor, action, target, risk, payload, created_at`,
      [
        input.id ?? `audit_${crypto.randomUUID()}`,
        input.runId ?? null,
        input.stepId ?? null,
        input.actor,
        input.action,
        input.target,
        input.risk ?? null,
        JSON.stringify(input.payload ?? null),
        input.createdAt ?? new Date().toISOString()
      ]
    );
    return mapAudit(result.rows[0]);
  }

  async list(runId?: string): Promise<AuditRecord[]> {
    const result = runId
      ? await this.pool.query("SELECT id, run_id, step_id, actor, action, target, risk, payload, created_at FROM audit_logs WHERE run_id = $1 ORDER BY created_at ASC", [runId])
      : await this.pool.query("SELECT id, run_id, step_id, actor, action, target, risk, payload, created_at FROM audit_logs ORDER BY created_at ASC");
    return result.rows.map(mapAudit);
  }
}

function mapAudit(row: any): AuditRecord {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    stepId: row.step_id ?? undefined,
    actor: row.actor,
    action: row.action,
    target: row.target,
    risk: row.risk ?? undefined,
    payload: row.payload,
    createdAt: row.created_at.toISOString()
  };
}
