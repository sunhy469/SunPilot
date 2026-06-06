import type { SunPilotEvent } from "@sunpilot/protocol";
import type { EventRepository } from "../repositories/event.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresEventRepository implements EventRepository {
  constructor(private readonly pool: PostgresPool) {}

  async append(event: SunPilotEvent): Promise<SunPilotEvent> {
    const result = await this.pool.query(
      `INSERT INTO events (id, run_id, conversation_id, step_id, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, run_id, conversation_id, step_id, sequence, type, payload, created_at`,
      [
        event.id,
        event.runId,
        event.conversationId ?? null,
        event.stepId ?? null,
        event.type,
        JSON.stringify(event.payload ?? null),
        event.createdAt
      ]
    );
    if (result.rows[0]) return mapEvent(result.rows[0]);
    const existing = await this.pool.query(
      `SELECT id, run_id, conversation_id, step_id, sequence, type, payload, created_at
       FROM events WHERE id = $1`,
      [event.id],
    );
    return mapEvent(existing.rows[0]);
  }

  async listByRunId(runId: string): Promise<SunPilotEvent[]> {
    const result = await this.pool.query(
      "SELECT id, run_id, conversation_id, step_id, sequence, type, payload, created_at FROM events WHERE run_id = $1 ORDER BY sequence ASC, created_at ASC",
      [runId]
    );
    return result.rows.map(mapEvent);
  }

  async listByConversationId(conversationId: string, afterSequence = 0): Promise<SunPilotEvent[]> {
    const result = await this.pool.query(
      `SELECT id, run_id, conversation_id, step_id, sequence, type, payload, created_at
       FROM events
       WHERE conversation_id = $1 AND sequence > $2
       ORDER BY sequence ASC, created_at ASC`,
      [conversationId, afterSequence]
    );
    return result.rows.map(mapEvent);
  }
}

function mapEvent(row: any): SunPilotEvent {
  return {
    id: row.id,
    runId: row.run_id,
    conversationId: row.conversation_id ?? undefined,
    stepId: row.step_id ?? undefined,
    sequence: row.sequence === undefined || row.sequence === null ? undefined : Number(row.sequence),
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString()
  };
}
