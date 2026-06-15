import type {
  CompleteModelCallInput,
  CreateModelCallInput,
  ModelCallRecord,
  ModelCallRepository,
  ModelCallStatus,
} from "../repositories/model-call.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresModelCallRepository implements ModelCallRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateModelCallInput): Promise<ModelCallRecord> {
    const result = await this.pool.query(
      `INSERT INTO model_calls (
         id, run_id, provider, model, purpose, input_tokens, output_tokens,
         latency_ms, cost_estimate, status, error, metadata, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13)
       RETURNING id, run_id, provider, model, purpose, input_tokens, output_tokens,
         latency_ms, cost_estimate, status, error, metadata, created_at`,
      [
        input.id ?? `model_${crypto.randomUUID()}`,
        input.runId ?? null,
        input.provider,
        input.model,
        input.purpose,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.latencyMs ?? null,
        input.costEstimate ?? null,
        input.status ?? "pending",
        input.error === undefined ? null : JSON.stringify(input.error),
        input.metadata ? JSON.stringify(input.metadata) : JSON.stringify({}),
        input.createdAt ?? new Date().toISOString(),
      ],
    );
    return mapModelCall(result.rows[0]);
  }

  async updateStatus(
    id: string,
    status: ModelCallStatus,
    input: CompleteModelCallInput = {},
  ): Promise<ModelCallRecord | null> {
    const result = await this.pool.query(
      `UPDATE model_calls
       SET status = $1,
           input_tokens = COALESCE($2, input_tokens),
           output_tokens = COALESCE($3, output_tokens),
           latency_ms = COALESCE($4, latency_ms),
           cost_estimate = COALESCE($5, cost_estimate),
           error = COALESCE($6::jsonb, error)
       WHERE id = $7
       RETURNING id, run_id, provider, model, purpose, input_tokens, output_tokens,
         latency_ms, cost_estimate, status, error, metadata, created_at`,
      [
        status,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.latencyMs ?? null,
        input.costEstimate ?? null,
        input.error === undefined ? null : JSON.stringify(input.error),
        id,
      ],
    );
    return result.rows[0] ? mapModelCall(result.rows[0]) : null;
  }

  async findById(id: string): Promise<ModelCallRecord | null> {
    const result = await this.pool.query(
      `SELECT id, run_id, provider, model, purpose, input_tokens, output_tokens,
         latency_ms, cost_estimate, status, error, metadata, created_at
       FROM model_calls WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapModelCall(result.rows[0]) : null;
  }

  async listByRunId(runId: string): Promise<ModelCallRecord[]> {
    const result = await this.pool.query(
      `SELECT id, run_id, provider, model, purpose, input_tokens, output_tokens,
         latency_ms, cost_estimate, status, error, metadata, created_at
       FROM model_calls WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return result.rows.map(mapModelCall);
  }
}

function mapModelCall(row: any): ModelCallRecord {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    provider: row.provider,
    model: row.model,
    purpose: row.purpose,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    latencyMs: row.latency_ms ?? undefined,
    costEstimate: row.cost_estimate ?? undefined,
    status: row.status,
    error: row.error ?? undefined,
    metadata: row.metadata ?? undefined,
    createdAt: row.created_at.toISOString(),
  };
}
