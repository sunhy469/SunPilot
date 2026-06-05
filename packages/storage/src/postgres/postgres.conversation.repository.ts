import type { ConversationRecord, ConversationRepository, CreateConversationInput, ListConversationsInput } from "../repositories/conversation.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresConversationRepository implements ConversationRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateConversationInput = {}): Promise<ConversationRecord> {
    const id = input.id ?? `conv_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO conversations (id, title)
       VALUES ($1, $2)
       RETURNING id, title, status, created_at, updated_at`,
      [id, input.title ?? null]
    );
    return mapConversation(result.rows[0]);
  }

  async findById(id: string): Promise<ConversationRecord | null> {
    const result = await this.pool.query("SELECT id, title, status, created_at, updated_at FROM conversations WHERE id = $1", [id]);
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async list(input: ListConversationsInput = {}): Promise<ConversationRecord[]> {
    const limit = Math.max(1, Math.min(input.limit ?? 50, 200));
    const result = await this.pool.query("SELECT id, title, status, created_at, updated_at FROM conversations ORDER BY updated_at DESC LIMIT $1", [limit]);
    return result.rows.map(mapConversation);
  }

  async touch(id: string): Promise<void> {
    await this.pool.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [id]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM conversations WHERE id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}

function mapConversation(row: any): ConversationRecord {
  return {
    id: row.id,
    title: row.title ?? undefined,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
