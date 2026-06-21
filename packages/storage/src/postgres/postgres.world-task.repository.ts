import type {
  WorldTaskRecord,
  CreateWorldTaskInput,
  UpdateWorldTaskPatch,
  WorldTaskRepository,
} from "../repositories/world-task.repository.js";
import type { PostgresPool } from "./postgres.client.js";

const TASK_COLUMNS = `
  id, being_id, type, status, title, input, current_action_id,
  created_at, started_at, completed_at
`;

function mapTask(row: Record<string, unknown>): WorldTaskRecord {
  return {
    id: row["id"] as string,
    beingId: row["being_id"] as string,
    type: row["type"] as string,
    status: row["status"] as string,
    title: row["title"] as string,
    input: (row["input"] as Record<string, unknown>) ?? {},
    currentActionId: (row["current_action_id"] as string) ?? undefined,
    createdAt: row["created_at"] as string,
    startedAt: (row["started_at"] as string) ?? undefined,
    completedAt: (row["completed_at"] as string) ?? undefined,
  };
}

export class PostgresWorldTaskRepository implements WorldTaskRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateWorldTaskInput): Promise<WorldTaskRecord> {
    const id = input.id ?? `task_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO world_tasks (id, being_id, type, status, title, input, current_action_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${TASK_COLUMNS}`,
      [
        id,
        input.beingId,
        input.type,
        "queued",
        input.title,
        JSON.stringify(input.input ?? {}),
        null,
        now,
      ],
    );
    return mapTask(result.rows[0]);
  }

  async findById(id: string): Promise<WorldTaskRecord | null> {
    const result = await this.pool.query(
      `SELECT ${TASK_COLUMNS} FROM world_tasks WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapTask(result.rows[0]);
  }

  async listByBeingId(beingId: string): Promise<WorldTaskRecord[]> {
    const result = await this.pool.query(
      `SELECT ${TASK_COLUMNS} FROM world_tasks WHERE being_id = $1 ORDER BY created_at DESC`,
      [beingId],
    );
    return result.rows.map(mapTask);
  }

  async update(id: string, patch: UpdateWorldTaskPatch): Promise<WorldTaskRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const fields: Record<string, unknown> = {
      status: patch.status,
      current_action_id: patch.currentActionId,
      started_at: patch.startedAt,
      completed_at: patch.completedAt,
    };

    for (const [column, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${column} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (sets.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    const result = await this.pool.query(
      `UPDATE world_tasks SET ${sets.join(", ")} WHERE id = $${idx} RETURNING ${TASK_COLUMNS}`,
      values,
    );
    if (result.rows.length === 0) return null;
    return mapTask(result.rows[0]);
  }
}
