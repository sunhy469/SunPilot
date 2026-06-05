import type { RunMode, RunRecord, RunStatus } from "@sunpilot/protocol";
import type { CreateRunInput, ListRunsInput, RunRepository } from "../repositories/run.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresRunRepository implements RunRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateRunInput): Promise<RunRecord> {
    const result = await this.pool.query(
      `INSERT INTO runs (id, title, status, mode, workflow_id, created_at, updated_at, completed_at, input, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)
       RETURNING id, title, status, mode, workflow_id, created_at, updated_at, completed_at, input, context`,
      [
        input.id,
        input.title,
        input.status,
        input.mode,
        input.workflowId ?? null,
        input.createdAt,
        input.updatedAt,
        input.completedAt ?? null,
        JSON.stringify(input.input ?? null),
        JSON.stringify(input.context ?? {})
      ]
    );
    return mapRun(result.rows[0]);
  }

  async findById(id: string): Promise<RunRecord | null> {
    const result = await this.pool.query("SELECT id, title, status, mode, workflow_id, created_at, updated_at, completed_at, input, context FROM runs WHERE id = $1", [id]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async list(input: ListRunsInput = {}): Promise<RunRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const result = await this.pool.query("SELECT id, title, status, mode, workflow_id, created_at, updated_at, completed_at, input, context FROM runs ORDER BY created_at DESC LIMIT $1", [limit]);
    return result.rows.map(mapRun);
  }

  async updateStatus(id: string, status: RunStatus, completedAt?: string): Promise<void> {
    await this.pool.query(
      "UPDATE runs SET status = $1, updated_at = NOW(), completed_at = COALESCE($2, completed_at) WHERE id = $3",
      [status, completedAt ?? null, id]
    );
  }

  async updateContext(id: string, context: Record<string, unknown>): Promise<void> {
    await this.pool.query("UPDATE runs SET context = $1::jsonb, updated_at = NOW() WHERE id = $2", [JSON.stringify(context), id]);
  }
}

function mapRun(row: any): RunRecord {
  return {
    id: row.id,
    title: row.title,
    status: row.status as RunStatus,
    mode: row.mode as RunMode,
    workflowId: row.workflow_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    input: row.input,
    context: row.context ?? {}
  };
}
