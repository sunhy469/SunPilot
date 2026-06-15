import type {
  CompleteToolCallInput,
  CreateToolCallInput,
  ToolCallRecord,
  ToolCallRepository,
  ToolCallStatus,
} from "../repositories/tool-call.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresToolCallRepository implements ToolCallRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateToolCallInput): Promise<ToolCallRecord> {
    const result = await this.pool.query(
      `INSERT INTO tool_calls (
         id, run_id, step_id, skill_id, name, arguments, status, risk_level,
         approval_id, metadata, started_at, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12)
       ON CONFLICT (id) DO UPDATE
       SET status = EXCLUDED.status,
           started_at = COALESCE(tool_calls.started_at, EXCLUDED.started_at)
       RETURNING id, run_id, step_id, skill_id, name, arguments, result, status,
         risk_level, approval_id, error, metadata, started_at, completed_at, created_at`,
      [
        input.id,
        input.runId,
        input.stepId ?? null,
        input.skillId,
        input.name,
        JSON.stringify(input.arguments ?? {}),
        input.status ?? "pending",
        input.riskLevel ?? "low",
        input.approvalId ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.startedAt ?? null,
        input.createdAt ?? new Date().toISOString(),
      ],
    );
    return mapToolCall(result.rows[0]);
  }

  async updateStatus(
    id: string,
    status: ToolCallStatus,
    input: CompleteToolCallInput = {},
  ): Promise<ToolCallRecord | null> {
    const terminal = ["completed", "failed", "cancelled", "timeout"].includes(
      status,
    );
    const result = await this.pool.query(
      `UPDATE tool_calls
       SET status = $1,
           result = COALESCE($2::jsonb, result),
           error = COALESCE($3::jsonb, error),
           started_at = CASE WHEN $1 = 'running' THEN COALESCE(started_at, NOW()) ELSE started_at END,
           completed_at = CASE WHEN $4 THEN COALESCE($5, NOW()) ELSE completed_at END
       WHERE id = $6
       RETURNING id, run_id, step_id, skill_id, name, arguments, result, status,
         risk_level, approval_id, error, metadata, started_at, completed_at, created_at`,
      [
        status,
        input.result === undefined ? null : JSON.stringify(input.result),
        input.error === undefined ? null : JSON.stringify(input.error),
        terminal,
        input.completedAt ?? null,
        id,
      ],
    );
    return result.rows[0] ? mapToolCall(result.rows[0]) : null;
  }

  async findById(id: string): Promise<ToolCallRecord | null> {
    const result = await this.pool.query(
      `SELECT id, run_id, step_id, skill_id, name, arguments, result, status,
         risk_level, approval_id, error, metadata, started_at, completed_at, created_at
       FROM tool_calls WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapToolCall(result.rows[0]) : null;
  }

  async listByRunId(runId: string): Promise<ToolCallRecord[]> {
    const result = await this.pool.query(
      `SELECT id, run_id, step_id, skill_id, name, arguments, result, status,
         risk_level, approval_id, error, metadata, started_at, completed_at, created_at
       FROM tool_calls WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return result.rows.map(mapToolCall);
  }
}

function mapToolCall(row: any): ToolCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    skillId: row.skill_id,
    name: row.name,
    arguments: row.arguments ?? {},
    result: row.result ?? undefined,
    status: row.status,
    riskLevel: row.risk_level,
    approvalId: row.approval_id ?? undefined,
    error: row.error ?? undefined,
    metadata: row.metadata ?? undefined,
    startedAt: row.started_at?.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}
