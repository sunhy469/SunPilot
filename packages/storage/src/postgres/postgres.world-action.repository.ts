import type {
  WorldActionRecord,
  CreateWorldActionInput,
  UpdateWorldActionPatch,
  WorldActionRepository,
} from "../repositories/world-action.repository.js";
import type { PostgresPool } from "./postgres.client.js";

const ACTION_COLUMNS = `
  id, task_id, being_id, type, status,
  from_node_id, to_node_id, route_node_ids,
  agent_run_id, status_text, started_at, completed_at, error, params, created_at
`;

function mapAction(row: Record<string, unknown>): WorldActionRecord {
  return {
    id: row["id"] as string,
    taskId: row["task_id"] as string,
    beingId: row["being_id"] as string,
    type: row["type"] as string,
    status: row["status"] as string,
    fromNodeId: (row["from_node_id"] as string) ?? undefined,
    toNodeId: (row["to_node_id"] as string) ?? undefined,
    routeNodeIds: (row["route_node_ids"] as string[]) ?? undefined,
    agentRunId: (row["agent_run_id"] as string) ?? undefined,
    statusText: (row["status_text"] as string) ?? "",
    startedAt: row["started_at"] ? new Date(row["started_at"] as Date).toISOString() : undefined,
    completedAt: row["completed_at"] ? new Date(row["completed_at"] as Date).toISOString() : undefined,
    error: row["error"] ?? undefined,
    params: (row["params"] as Record<string, unknown>) ?? {},
    createdAt: new Date(row["created_at"] as Date).toISOString(),
  };
}

export class PostgresWorldActionRepository implements WorldActionRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateWorldActionInput): Promise<WorldActionRecord> {
    const id = input.id ?? `action_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO world_actions (id, task_id, being_id, type, status, from_node_id, to_node_id, route_node_ids, agent_run_id, status_text, params, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${ACTION_COLUMNS}`,
      [
        id,
        input.taskId,
        input.beingId,
        input.type,
        "pending",
        input.fromNodeId ?? null,
        input.toNodeId ?? null,
        input.routeNodeIds ? JSON.stringify(input.routeNodeIds) : null,
        null,
        input.statusText ?? "",
        JSON.stringify(input.params ?? {}),
        input.createdAt ?? now,
      ],
    );
    return mapAction(result.rows[0]);
  }

  async findById(id: string): Promise<WorldActionRecord | null> {
    const result = await this.pool.query(
      `SELECT ${ACTION_COLUMNS} FROM world_actions WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapAction(result.rows[0]);
  }

  async listByTaskId(taskId: string): Promise<WorldActionRecord[]> {
    const result = await this.pool.query(
      `SELECT ${ACTION_COLUMNS} FROM world_actions WHERE task_id = $1 ORDER BY created_at ASC`,
      [taskId],
    );
    return result.rows.map(mapAction);
  }

  async listByBeingId(beingId: string): Promise<WorldActionRecord[]> {
    const result = await this.pool.query(
      `SELECT ${ACTION_COLUMNS} FROM world_actions WHERE being_id = $1 ORDER BY created_at DESC`,
      [beingId],
    );
    return result.rows.map(mapAction);
  }

  async update(id: string, patch: UpdateWorldActionPatch): Promise<WorldActionRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const fields: Record<string, unknown> = {
      status: patch.status,
      agent_run_id: patch.agentRunId,
      from_node_id: patch.fromNodeId,
      to_node_id: patch.toNodeId,
      route_node_ids: patch.routeNodeIds ? JSON.stringify(patch.routeNodeIds) : undefined,
      status_text: patch.statusText,
      started_at: patch.startedAt,
      completed_at: patch.completedAt,
      error: patch.error ? JSON.stringify(patch.error) : undefined,
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
      `UPDATE world_actions SET ${sets.join(", ")} WHERE id = $${idx} RETURNING ${ACTION_COLUMNS}`,
      values,
    );
    if (result.rows.length === 0) return null;
    return mapAction(result.rows[0]);
  }
}
