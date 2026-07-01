import type { CreateMessageInput, MessageRecord, MessageRepository } from "../repositories/message.repository.js";
import type { PostgresPool } from "./postgres.client.js";
import { withPostgresTransaction } from "./postgres.transaction.js";

export class PostgresMessageRepository implements MessageRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateMessageInput): Promise<MessageRecord> {
    const id = input.id ?? `msg_${crypto.randomUUID()}`;
    const metadata = {
      ...(input.metadata ?? {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    };
    const embeddingValue = input.embedding?.length
      ? formatVector(input.embedding)
      : null;
    // Insert the message and refresh the conversation's updated_at atomically
    // so a failure can't leave a message without a touched conversation (or vice versa).
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO messages (id, conversation_id, role, content, metadata, embedding)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::vector)
         ON CONFLICT (id) DO UPDATE SET
           content = EXCLUDED.content,
           metadata = EXCLUDED.metadata,
           embedding = COALESCE(EXCLUDED.embedding, messages.embedding)
         WHERE messages.conversation_id = EXCLUDED.conversation_id
           AND messages.role = EXCLUDED.role
         RETURNING id, conversation_id, role, content, metadata, created_at`,
        [id, input.conversationId, input.role, input.content, JSON.stringify(metadata), embeddingValue],
      );
      await client.query("UPDATE conversations SET updated_at = NOW() WHERE id = $1", [input.conversationId]);
      if (!result.rows[0]) {
        throw new Error(`Message ${id} belongs to a different conversation or role`);
      }
      return mapMessage(result.rows[0]);
    });
  }

  async listByConversationId(conversationId: string): Promise<MessageRecord[]> {
    const result = await this.pool.query(
      "SELECT id, conversation_id, role, content, metadata, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return result.rows.map(mapMessage);
  }

  async searchByEmbedding(conversationId: string, embedding: number[], limit: number): Promise<MessageRecord[]> {
    const vectorStr = formatVector(embedding);
    const result = await this.pool.query(
      `SELECT id, conversation_id, role, content, metadata, created_at,
              embedding <=> $2::vector AS _distance
       FROM messages
       WHERE conversation_id = $1 AND embedding IS NOT NULL
       ORDER BY embedding <=> $2::vector
       LIMIT $3`,
      [conversationId, vectorStr, limit],
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

/** Format a number array as a pgvector-compatible string literal: '[1,2,3]' */
function formatVector(vec: number[]): string {
  return `[${vec.join(",")}]`;
}
