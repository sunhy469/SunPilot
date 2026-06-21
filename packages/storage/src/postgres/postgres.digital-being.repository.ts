import type {
  DigitalBeingRecord,
  CreateDigitalBeingInput,
  UpdateDigitalBeingPatch,
  DigitalBeingRepository,
} from "../repositories/digital-being.repository.js";
import type { PostgresPool } from "./postgres.client.js";

const BEING_COLUMNS = `
  id, name, description, body_type, color, icon, status,
  current_node_id, target_node_id, home_node_id,
  current_task_id, current_action_id, current_run_id,
  conversation_id, status_text, sleep_reason,
  daily_run_limit, daily_skill_call_limit, token_budget,
  used_runs, used_skill_calls, cooldown_until,
  created_at, updated_at
`;

function mapBeing(row: Record<string, unknown>): DigitalBeingRecord {
  return {
    id: row["id"] as string,
    name: row["name"] as string,
    description: (row["description"] as string) ?? undefined,
    bodyType: (row["body_type"] as string) ?? "tracked_worker",
    color: (row["color"] as string) ?? undefined,
    icon: (row["icon"] as string) ?? undefined,
    status: row["status"] as string,
    currentNodeId: row["current_node_id"] as string,
    targetNodeId: (row["target_node_id"] as string) ?? undefined,
    homeNodeId: row["home_node_id"] as string,
    currentTaskId: (row["current_task_id"] as string) ?? undefined,
    currentActionId: (row["current_action_id"] as string) ?? undefined,
    currentRunId: (row["current_run_id"] as string) ?? undefined,
    conversationId: (row["conversation_id"] as string) ?? undefined,
    statusText: (row["status_text"] as string) ?? undefined,
    sleepReason: (row["sleep_reason"] as string) ?? undefined,
    dailyRunLimit: (row["daily_run_limit"] as number) ?? undefined,
    dailySkillCallLimit: (row["daily_skill_call_limit"] as number) ?? undefined,
    tokenBudget: (row["token_budget"] as number) ?? undefined,
    usedRuns: (row["used_runs"] as number) ?? 0,
    usedSkillCalls: (row["used_skill_calls"] as number) ?? 0,
    cooldownUntil: (row["cooldown_until"] as string) ?? undefined,
    createdAt: row["created_at"] as string,
    updatedAt: row["updated_at"] as string,
  };
}

export class PostgresDigitalBeingRepository implements DigitalBeingRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateDigitalBeingInput): Promise<DigitalBeingRecord> {
    const id = input.id ?? `being_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO digital_beings (
        id, name, description, body_type, color, icon, status,
        current_node_id, target_node_id, home_node_id,
        current_task_id, current_action_id, current_run_id,
        conversation_id, status_text, sleep_reason,
        daily_run_limit, daily_skill_call_limit, token_budget,
        used_runs, used_skill_calls, cooldown_until,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      RETURNING ${BEING_COLUMNS}`,
      [
        id,
        input.name,
        input.description ?? null,
        input.bodyType ?? "tracked_worker",
        input.color ?? null,
        input.icon ?? null,
        "idle",
        input.currentNodeId ?? input.homeNodeId,
        null,
        input.homeNodeId,
        null,
        null,
        null,
        input.conversationId ?? null,
        null,
        null,
        input.dailyRunLimit ?? null,
        input.dailySkillCallLimit ?? null,
        input.tokenBudget ?? null,
        0,
        0,
        null,
        now,
        now,
      ],
    );
    return mapBeing(result.rows[0]);
  }

  async findById(id: string): Promise<DigitalBeingRecord | null> {
    const result = await this.pool.query(
      `SELECT ${BEING_COLUMNS} FROM digital_beings WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapBeing(result.rows[0]);
  }

  async list(): Promise<DigitalBeingRecord[]> {
    const result = await this.pool.query(
      `SELECT ${BEING_COLUMNS} FROM digital_beings ORDER BY created_at ASC`,
    );
    return result.rows.map(mapBeing);
  }

  async update(id: string, patch: UpdateDigitalBeingPatch): Promise<DigitalBeingRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const fields: Record<string, unknown> = {
      name: patch.name,
      description: patch.description,
      status: patch.status,
      current_node_id: patch.currentNodeId,
      target_node_id: patch.targetNodeId,
      current_task_id: patch.currentTaskId,
      current_action_id: patch.currentActionId,
      current_run_id: patch.currentRunId,
      status_text: patch.statusText,
      sleep_reason: patch.sleepReason,
      used_runs: patch.usedRuns,
      used_skill_calls: patch.usedSkillCalls,
      cooldown_until: patch.cooldownUntil,
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

    sets.push(`updated_at = $${idx}`);
    values.push(new Date().toISOString());
    idx++;

    values.push(id);
    const result = await this.pool.query(
      `UPDATE digital_beings SET ${sets.join(", ")} WHERE id = $${idx} RETURNING ${BEING_COLUMNS}`,
      values,
    );
    if (result.rows.length === 0) return null;
    return mapBeing(result.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM digital_beings WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
