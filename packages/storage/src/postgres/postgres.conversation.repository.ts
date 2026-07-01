import type {
  ConversationRecord,
  ConversationRepository,
  CreateConversationInput,
  ListConversationsInput,
  UpdateConversationPatch,
} from "../repositories/conversation.repository.js";
import type { PostgresPool } from "./postgres.client.js";
import { withPostgresTransaction } from "./postgres.transaction.js";
import type { PoolClient } from "pg";

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(
    input: CreateConversationInput = {},
  ): Promise<ConversationRecord> {
    const id = input.id ?? `conv_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO conversations (id, title, kind)
       VALUES ($1, $2, $3)
       RETURNING id, title, status, kind, pinned, created_at, updated_at`,
      [id, input.title ?? null, input.kind ?? "chat"],
    );
    return mapConversation(result.rows[0]);
  }

  async findById(id: string): Promise<ConversationRecord | null> {
    const result = await this.pool.query(
      "SELECT id, title, status, kind, pinned, created_at, updated_at FROM conversations WHERE id = $1",
      [id],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async findByIdForUpdate(id: string): Promise<ConversationRecord | null> {
    const result = await this.pool.query(
      `SELECT id, title, status, kind, pinned, created_at, updated_at
       FROM conversations WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async list(
    input: ListConversationsInput = {},
  ): Promise<ConversationRecord[]> {
    const limit = Math.max(1, Math.min(Number(input.limit ?? 50), 200));
    const cursor = decodeConversationCursor(input.cursor);
    if (cursor) {
      if (cursor.pinned !== undefined) {
        // Tuple comparison correctly pages across the pinned/unpinned
        // boundary under ORDER BY pinned DESC, updated_at DESC, id DESC.
        const result = await this.pool.query(
          `SELECT id, title, status, kind, pinned, created_at, updated_at
           FROM conversations
           WHERE (pinned, updated_at, id) < ($1, $2, $3)
           ORDER BY pinned DESC, updated_at DESC, id DESC
           LIMIT $4`,
          [cursor.pinned, cursor.updatedAt, cursor.id, limit],
        );
        return result.rows.map(mapConversation);
      }
      // Backward compat: old cursor without pinned field.
      const result = await this.pool.query(
        `SELECT id, title, status, kind, pinned, created_at, updated_at
         FROM conversations
         WHERE updated_at < $1 OR (updated_at = $1 AND id < $2)
         ORDER BY pinned DESC, updated_at DESC, id DESC
         LIMIT $3`,
        [cursor.updatedAt, cursor.id, limit],
      );
      return result.rows.map(mapConversation);
    }
    const result = await this.pool.query(
      `SELECT id, title, status, kind, pinned, created_at, updated_at
       FROM conversations
       ORDER BY pinned DESC, updated_at DESC, id DESC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapConversation);
  }

  async touch(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE conversations SET updated_at = NOW() WHERE id = $1",
      [id],
    );
  }

  async update(
    id: string,
    patch: UpdateConversationPatch,
  ): Promise<ConversationRecord | null> {
    const sets: string[] = [];
    const values: (string | boolean)[] = [];
    let paramIndex = 1;

    if (patch.title !== undefined) {
      sets.push(`title = $${paramIndex++}`);
      values.push(patch.title);
    }
    if (patch.pinned !== undefined) {
      sets.push(`pinned = $${paramIndex++}`);
      values.push(patch.pinned);
    }

    if (sets.length === 0) return null;

    sets.push(`updated_at = NOW()`);
    values.push(id);

    const result = await this.pool.query(
      `UPDATE conversations
       SET ${sets.join(", ")}
       WHERE id = $${paramIndex}
       RETURNING id, title, status, kind, pinned, created_at, updated_at`,
      values,
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const remove = async (client: Pick<PoolClient, "query">): Promise<boolean> => {
      // Detach digital beings pointing at this conversation (no ON DELETE cascade).
      await client.query(
        "UPDATE digital_beings SET conversation_id = NULL WHERE conversation_id = $1",
        [id],
      );
      // Soft-delete conversation-scoped memories (no ON DELETE cascade).
      await client.query(
        "UPDATE memory_metadata SET deleted_at = NOW() WHERE scope = 'conversation' AND scope_id = $1",
        [id],
      );
      // Clean up related data that doesn't have ON DELETE CASCADE
      await client.query("DELETE FROM agent_traces WHERE conversation_id = $1", [id]);
      await client.query("DELETE FROM events WHERE conversation_id = $1", [id]);
      // messages has ON DELETE CASCADE, but delete explicitly for clarity
      await client.query("DELETE FROM messages WHERE conversation_id = $1", [id]);
      const result = await client.query(
        "DELETE FROM conversations WHERE id = $1",
        [id],
      );
      return (result.rowCount ?? 0) > 0;
    };

    // Repository methods are also used through a transaction-scoped
    // PostgresDatabaseContext whose query target is already a PoolClient.
    // Avoid calling connect()/BEGIN again in that case.
    return typeof (this.pool as { connect?: unknown }).connect === "function"
      ? withPostgresTransaction(this.pool, remove)
      : remove(this.pool as unknown as Pick<PoolClient, "query">);
  }
}

function decodeConversationCursor(
  cursor?: string,
): { pinned?: boolean; updatedAt: string; id: string } | undefined {
  if (!cursor) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      pinned?: unknown;
      updatedAt?: unknown;
      id?: unknown;
    };
    if (
      typeof decoded.updatedAt !== "string" ||
      typeof decoded.id !== "string"
    ) {
      return undefined;
    }
    return {
      pinned: typeof decoded.pinned === "boolean" ? decoded.pinned : undefined,
      updatedAt: decoded.updatedAt,
      id: decoded.id,
    };
  } catch {
    return undefined;
  }
}

function mapConversation(row: any): ConversationRecord {
  return {
    id: row.id,
    title: row.title ?? undefined,
    status: row.status,
    kind: row.kind ?? "chat",
    pinned: row.pinned ?? false,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
