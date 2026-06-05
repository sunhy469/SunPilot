import type { CreateJobInput, JobRecord, JobRepository } from "../repositories/job.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresJobRepository implements JobRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateJobInput): Promise<JobRecord> {
    const result = await this.pool.query(
      `INSERT INTO job_queue (id, run_id, status, attempts, timeout_at, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW(), NOW())
       RETURNING id, run_id, status, attempts, timeout_at, payload, created_at, updated_at`,
      [input.id, input.runId, input.status, input.attempts ?? 0, input.timeoutAt ?? null, JSON.stringify(input.payload ?? null)]
    );
    return mapJob(result.rows[0]);
  }

  async updateStatus(runId: string, status: string, incrementAttempts = false): Promise<void> {
    await this.pool.query(
      "UPDATE job_queue SET status = $1, attempts = attempts + $2, updated_at = NOW() WHERE run_id = $3",
      [status, incrementAttempts ? 1 : 0, runId]
    );
  }

  async list(runId?: string): Promise<JobRecord[]> {
    const result = runId
      ? await this.pool.query("SELECT id, run_id, status, attempts, timeout_at, payload, created_at, updated_at FROM job_queue WHERE run_id = $1 ORDER BY created_at ASC", [runId])
      : await this.pool.query("SELECT id, run_id, status, attempts, timeout_at, payload, created_at, updated_at FROM job_queue ORDER BY created_at ASC");
    return result.rows.map(mapJob);
  }

  async expireTimedOut(now = new Date().toISOString()): Promise<string[]> {
    const result = await this.pool.query(
      `UPDATE job_queue
       SET status = 'failed', updated_at = $1
       WHERE timeout_at IS NOT NULL AND timeout_at <= $1 AND status IN ('pending', 'running')
       RETURNING run_id`,
      [now]
    );
    return result.rows.map((row) => row.run_id as string);
  }
}

function mapJob(row: any): JobRecord {
  return {
    id: row.id,
    runId: row.run_id,
    status: row.status,
    attempts: row.attempts,
    timeoutAt: row.timeout_at?.toISOString(),
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
