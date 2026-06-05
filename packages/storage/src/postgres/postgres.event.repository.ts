import type { SunPilotEvent } from "@sunpilot/protocol";
import type { EventRepository } from "../repositories/event.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresEventRepository implements EventRepository {
  constructor(private readonly pool: PostgresPool) {}

  async append(event: SunPilotEvent): Promise<SunPilotEvent> {
    const result = await this.pool.query(
      `INSERT INTO events (id, run_id, step_id, type, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id, run_id, step_id, type, payload, created_at`,
      [event.id, event.runId, event.stepId ?? null, event.type, JSON.stringify(event.payload ?? null), event.createdAt]
    );
    return mapEvent(result.rows[0]);
  }

  async listByRunId(runId: string): Promise<SunPilotEvent[]> {
    const result = await this.pool.query("SELECT id, run_id, step_id, type, payload, created_at FROM events WHERE run_id = $1 ORDER BY created_at ASC", [runId]);
    return result.rows.map(mapEvent);
  }
}

function mapEvent(row: any): SunPilotEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    type: row.type,
    payload: row.payload,
    createdAt: row.created_at.toISOString()
  };
}
