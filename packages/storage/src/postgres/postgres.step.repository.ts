import type { StepRecord, StepStatus } from "@sunpilot/protocol";
import type { StepRepository } from "../repositories/step.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresStepRepository implements StepRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: StepRecord): Promise<StepRecord> {
    const result = await this.pool.query(
      `INSERT INTO steps (id, run_id, parent_step_id, type, name, status, workflow_id, skill_id, capability, input, output, error, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14)
       RETURNING id, run_id, parent_step_id, type, name, status, workflow_id, skill_id, capability, input, output, error, started_at, completed_at`,
      [
        input.id,
        input.runId,
        input.parentStepId ?? null,
        input.type,
        input.name,
        input.status,
        input.workflowId ?? null,
        input.skillId ?? null,
        input.capability ?? null,
        JSON.stringify(input.input ?? null),
        input.output === undefined ? null : JSON.stringify(input.output),
        input.error === undefined ? null : JSON.stringify(input.error),
        input.startedAt ?? null,
        input.completedAt ?? null
      ]
    );
    return mapStep(result.rows[0]);
  }

  async listByRunId(runId: string): Promise<StepRecord[]> {
    const result = await this.pool.query(
      "SELECT id, run_id, parent_step_id, type, name, status, workflow_id, skill_id, capability, input, output, error, started_at, completed_at FROM steps WHERE run_id = $1 ORDER BY created_order ASC",
      [runId]
    );
    return result.rows.map(mapStep);
  }

  async updateStatus(stepId: string, status: StepStatus, output?: unknown, error?: unknown): Promise<void> {
    const terminal = ["completed", "failed", "skipped", "cancelled", "interrupted"].includes(status);
    await this.pool.query(
      `UPDATE steps
       SET status = $1,
           output = COALESCE($2::jsonb, output),
           error = COALESCE($3::jsonb, error),
           started_at = CASE WHEN $4 = 'running' THEN COALESCE(started_at, NOW()) ELSE started_at END,
           completed_at = CASE WHEN $5 THEN NOW() ELSE NULL END
       WHERE id = $6`,
      [status, output === undefined ? null : JSON.stringify(output), error === undefined ? null : JSON.stringify(error), status, terminal, stepId]
    );
  }
}

function mapStep(row: any): StepRecord {
  return {
    id: row.id,
    runId: row.run_id,
    parentStepId: row.parent_step_id ?? undefined,
    type: row.type,
    name: row.name,
    status: row.status,
    workflowId: row.workflow_id ?? undefined,
    skillId: row.skill_id ?? undefined,
    capability: row.capability ?? undefined,
    input: row.input,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    startedAt: row.started_at?.toISOString(),
    completedAt: row.completed_at?.toISOString()
  };
}
