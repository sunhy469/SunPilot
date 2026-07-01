import type { SunPilotEvent } from "@sunpilot/protocol";
import type { EventRepository } from "../repositories/event.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresEventRepository implements EventRepository {
  constructor(private readonly pool: PostgresPool) {}

  async append(event: SunPilotEvent): Promise<SunPilotEvent> {
    const result = await this.pool.query(
      `INSERT INTO events (id, run_id, conversation_id, step_id, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
       ON CONFLICT (id) DO UPDATE SET created_at = events.created_at
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
    return mapEvent(result.rows[0]);
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

  async enqueueOutbox(event: SunPilotEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_event_outbox (event_id, event)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.id, JSON.stringify(event)],
    );
  }

  async listOutbox(limit = 200): Promise<SunPilotEvent[]> {
    const result = await this.pool.query(
      `SELECT event FROM agent_event_outbox
       ORDER BY created_at ASC, event_id ASC
       LIMIT $1`,
      [Math.max(1, Math.min(limit, 1_000))],
    );
    return result.rows.map((row) => row.event as SunPilotEvent);
  }

  async deleteOutbox(eventId: string): Promise<void> {
    await this.pool.query(
      "DELETE FROM agent_event_outbox WHERE event_id = $1",
      [eventId],
    );
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
