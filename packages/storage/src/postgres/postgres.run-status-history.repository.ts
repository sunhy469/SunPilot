import type {
  CreateRunStatusHistoryInput,
  RunStatusHistoryRecord,
  RunStatusHistoryRepository,
} from "../repositories/run-status-history.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresRunStatusHistoryRepository
  implements RunStatusHistoryRepository
{
  constructor(private readonly pool: PostgresPool) {}

  async append(
    input: CreateRunStatusHistoryInput,
  ): Promise<RunStatusHistoryRecord> {
    const now = input.createdAt ?? new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO run_status_history (
         id, run_id, previous_status, next_status, reason, actor, metadata, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING id, run_id, previous_status, next_status, reason, actor, metadata, created_at`,
      [
        input.id ?? `rsh_${crypto.randomUUID()}`,
        input.runId,
        input.previousStatus ?? null,
        input.nextStatus,
        input.reason ?? null,
        input.actor ?? "system",
        JSON.stringify(input.metadata ?? {}),
        now,
      ],
    );
    return mapRunStatusHistory(result.rows[0]);
  }

  async listByRunId(runId: string): Promise<RunStatusHistoryRecord[]> {
    const result = await this.pool.query(
      `SELECT id, run_id, previous_status, next_status, reason, actor, metadata, created_at
       FROM run_status_history
       WHERE run_id = $1
       ORDER BY created_at ASC`,
      [runId],
    );
    return result.rows.map(mapRunStatusHistory);
  }
}

function mapRunStatusHistory(row: any): RunStatusHistoryRecord {
  return {
    id: row.id,
    runId: row.run_id,
    previousStatus: row.previous_status ?? undefined,
    nextStatus: row.next_status,
    reason: row.reason ?? undefined,
    actor: row.actor,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
  };
}
