import type { CreateMessageInput, MessageRecord, MessageRepository } from "../repositories/message.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateMessageInput): Promise<MessageRecord> {
    const id = input.id ?? `msg_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO messages (id, conversation_id, role, content, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, conversation_id, role, content, metadata, created_at`,
      [id, input.conversationId, input.role, input.content, JSON.stringify(input.metadata ?? {})]
    );
    await this.pool.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [input.conversationId]);
    return mapMessage(result.rows[0]);
  }

  async listByConversationId(conversationId: string): Promise<MessageRecord[]> {
    const result = await this.pool.query(
      "SELECT id, conversation_id, role, content, metadata, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return result.rows.map(mapMessage);
  }
}

function mapMessage(row: any): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString()
  };
}
