import type {
  WorldActionLogRecord,
  WorldActionLogRepository,
  CreateWorldActionLogInput,
} from "../repositories/world-action-log.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresWorldActionLogRepository implements WorldActionLogRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateWorldActionLogInput): Promise<WorldActionLogRecord> {
    const id = input.id ?? `wal_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO world_action_logs (id, action_id, being_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, action_id, being_id, event_type, payload, created_at`,
      [
        id,
        input.actionId,
        input.beingId,
        input.eventType,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return mapWorldActionLog(result.rows[0]);
  }

  async listByActionId(actionId: string): Promise<WorldActionLogRecord[]> {
    const result = await this.pool.query(
      "SELECT id, action_id, being_id, event_type, payload, created_at FROM world_action_logs WHERE action_id = $1 ORDER BY created_at DESC",
      [actionId],
    );
    return result.rows.map(mapWorldActionLog);
  }

  async listByBeingId(beingId: string): Promise<WorldActionLogRecord[]> {
    const result = await this.pool.query(
      "SELECT id, action_id, being_id, event_type, payload, created_at FROM world_action_logs WHERE being_id = $1 ORDER BY created_at DESC",
      [beingId],
    );
    return result.rows.map(mapWorldActionLog);
  }
}

function mapWorldActionLog(row: any): WorldActionLogRecord {
  return {
    id: row.id,
    actionId: row.action_id,
    beingId: row.being_id,
    eventType: row.event_type,
    payload: row.payload ?? {},
    createdAt: row.created_at as string,
  };
}
