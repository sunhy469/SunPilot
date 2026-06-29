import type {
  IdempotencyRecord,
  IdempotencyRepository,
  ReserveIdempotencyInput,
} from "../repositories/idempotency.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresIdempotencyRepository implements IdempotencyRepository {
  constructor(private readonly pool: PostgresPool) {}

  async reserve(input: ReserveIdempotencyInput): Promise<{
    inserted: boolean;
    record: IdempotencyRecord;
  }> {
    const id = input.id ?? `idem_${crypto.randomUUID()}`;
    const createdAt = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO idempotency_keys (
         id, user_id, method, client_request_id, request_hash, response,
         status, created_at, expires_at
       )
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'processing', $7, $8)
       ON CONFLICT ((COALESCE(user_id, '')), method, client_request_id)
       DO UPDATE SET
         status = 'processing',
         request_hash = EXCLUDED.request_hash,
         response = EXCLUDED.response,
         error = NULL,
         created_at = EXCLUDED.created_at,
         expires_at = EXCLUDED.expires_at
       WHERE idempotency_keys.status = 'processing'
         AND idempotency_keys.expires_at IS NOT NULL
         AND idempotency_keys.expires_at <= NOW()
       RETURNING id, user_id, method, client_request_id, request_hash,
         response, error, status, created_at, expires_at`,
      [
        id,
        input.userId ?? null,
        input.method,
        input.clientRequestId,
        input.requestHash,
        input.initialResponse === undefined
          ? null
          : JSON.stringify(input.initialResponse),
        createdAt,
        input.expiresAt ?? null,
      ],
    );
    if (result.rows[0]) {
      return { inserted: true, record: mapIdempotency(result.rows[0]) };
    }
    const existing = await this.findByKey(input);
    if (!existing) {
      throw new Error("Failed to reserve idempotency key.");
    }
    return { inserted: false, record: existing };
  }

  async complete(
    id: string,
    response: unknown,
  ): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query(
      `UPDATE idempotency_keys
       SET status = 'completed', response = $1::jsonb, error = NULL
       WHERE id = $2 AND status = 'processing'
       RETURNING id, user_id, method, client_request_id, request_hash,
         response, error, status, created_at, expires_at`,
      [JSON.stringify(response), id],
    );
    return result.rows[0] ? mapIdempotency(result.rows[0]) : null;
  }

  async fail(id: string, error: unknown): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query(
      `UPDATE idempotency_keys
       SET status = 'failed', error = $1::jsonb
       WHERE id = $2 AND status = 'processing'
       RETURNING id, user_id, method, client_request_id, request_hash,
         response, error, status, created_at, expires_at`,
      [JSON.stringify(error), id],
    );
    return result.rows[0] ? mapIdempotency(result.rows[0]) : null;
  }

  async release(id: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM idempotency_keys WHERE id = $1 AND status = 'processing'",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Delete expired in-flight reservations so they stop blocking retries. */
  async cleanupExpired(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM idempotency_keys
       WHERE status = 'processing'
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()`,
    );
    return result.rowCount ?? 0;
  }

  async findByKey(input: {
    userId?: string;
    method: string;
    clientRequestId: string;
  }): Promise<IdempotencyRecord | null> {
    const result = await this.pool.query(
      `SELECT id, user_id, method, client_request_id, request_hash,
         response, error, status, created_at, expires_at
       FROM idempotency_keys
       WHERE COALESCE(user_id, '') = COALESCE($1, '')
         AND method = $2
         AND client_request_id = $3`,
      [input.userId ?? null, input.method, input.clientRequestId],
    );
    return result.rows[0] ? mapIdempotency(result.rows[0]) : null;
  }
}

function mapIdempotency(row: any): IdempotencyRecord {
  return {
    id: row.id,
    userId: row.user_id ?? undefined,
    method: row.method,
    clientRequestId: row.client_request_id,
    requestHash: row.request_hash,
    response: row.response ?? undefined,
    error: row.error ?? undefined,
    status: row.status,
    createdAt: toIsoString(row.created_at),
    expiresAt: row.expires_at ? toIsoString(row.expires_at) : undefined,
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
