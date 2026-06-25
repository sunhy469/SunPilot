import type { RunMode, RunRecord, RunStatus } from "@sunpilot/protocol";
import type {
  CreateRunInput,
  ListRunsInput,
  RunRepository,
} from "../repositories/run.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresRunRepository implements RunRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateRunInput): Promise<RunRecord> {
    const result = await this.pool.query(
      `INSERT INTO runs (
         id, title, conversation_id, status, mode,
         user_id, goal, error, cancelled_at,
         created_at, updated_at, completed_at, input, context
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14::jsonb)
       RETURNING id, title, conversation_id, status, mode, user_id, goal, error,
         created_at, updated_at, completed_at, cancelled_at, input, context`,
      [
        input.id,
        input.title,
        input.conversationId ?? null,
        input.status,
        input.mode,
        input.userId ?? null,
        input.goal ?? null,
        input.error === undefined ? null : JSON.stringify(input.error),
        input.cancelledAt ?? null,
        input.createdAt,
        input.updatedAt,
        input.completedAt ?? null,
        JSON.stringify(input.input ?? null),
        JSON.stringify(input.context ?? {}),
      ],
    );
    return mapRun(result.rows[0]);
  }

  async findById(id: string): Promise<RunRecord | null> {
    const result = await this.pool.query(
      `SELECT id, title, conversation_id, status, mode, user_id, goal, error,
         created_at, updated_at, completed_at, cancelled_at, input, context
       FROM runs WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async list(input: ListRunsInput = {}): Promise<RunRecord[]> {
    const limit = Math.max(1, Math.min(Number(input.limit ?? 50), 200));
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (input.status) {
      values.push(input.status);
      conditions.push(`status = $${values.length}`);
    }
    if (input.mode) {
      values.push(input.mode);
      conditions.push(`mode = $${values.length}`);
    }
    if (input.conversationId) {
      values.push(input.conversationId);
      conditions.push(`conversation_id = $${values.length}`);
    }
    const cursor = decodeRunCursor(input.cursor);
    if (cursor) {
      values.push(cursor.updatedAt);
      const updatedAtParam = values.length;
      values.push(cursor.id);
      const idParam = values.length;
      conditions.push(
        `(updated_at < $${updatedAtParam} OR (updated_at = $${updatedAtParam} AND id < $${idParam}))`,
      );
    }
    values.push(limit);
    const result = await this.pool.query(
      `SELECT id, title, conversation_id, status, mode, user_id, goal, error,
         created_at, updated_at, completed_at, cancelled_at, input, context
       FROM runs
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapRun);
  }

  async updateStatus(
    id: string,
    input: {
      status: RunStatus;
      updatedAt?: string;
      completedAt?: string;
      cancelledAt?: string;
      error?: unknown;
    },
  ): Promise<void> {
    const sets: string[] = [
      "status = $1",
      "updated_at = COALESCE($2, NOW())",
      "completed_at = COALESCE($3, completed_at)",
      "cancelled_at = COALESCE($4, cancelled_at)",
    ];
    const values: unknown[] = [
      input.status,
      input.updatedAt ?? null,
      input.completedAt ?? null,
      input.cancelledAt ?? null,
    ];
    // Only update `error` when explicitly provided. This allows callers to
    // clear it (by passing null) instead of COALESCE silently preserving it.
    if (input.error !== undefined) {
      sets.push(`error = $${values.length + 1}::jsonb`);
      values.push(JSON.stringify(input.error));
    }
    values.push(id);
    await this.pool.query(
      `UPDATE runs SET ${sets.join(", ")} WHERE id = $${values.length}`,
      values,
    );
  }

  async updateContext(
    id: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    await this.pool.query(
      "UPDATE runs SET context = $1::jsonb, updated_at = NOW() WHERE id = $2",
      [JSON.stringify(context), id],
    );
  }
}

function decodeRunCursor(
  cursor?: string,
): { updatedAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      updatedAt?: unknown;
      id?: unknown;
    };
    if (
      typeof decoded.updatedAt !== "string" ||
      typeof decoded.id !== "string"
    ) {
      return undefined;
    }
    return { updatedAt: decoded.updatedAt, id: decoded.id };
  } catch {
    return undefined;
  }
}

function mapRun(row: any): RunRecord {
  return {
    id: row.id,
    title: row.title,
    conversationId: row.conversation_id ?? undefined,
    status: row.status as RunStatus,
    mode: row.mode as RunMode,
    userId: row.user_id ?? undefined,
    goal: row.goal ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    cancelledAt: row.cancelled_at?.toISOString(),
    input: row.input,
    context: row.context ?? {},
  };
}
