/**
 * Plan Snapshot repository — persists plan state at each revision.
 * Architecture doc: agent_architecture_next_steps.md §P0-2
 */

import type { PostgresPool } from "../postgres/postgres.client.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface CreatePlanSnapshotInput {
  id: string;
  runId: string;
  planId: string;
  version: number;
  eventType: "agent.plan.created" | "agent.plan.validated" | "agent.plan.revised";
  planJson: Record<string, unknown>;
  diffSummary?: string;
  trigger?: string;
  addedSteps?: number;
  removedSteps?: number;
  modifiedSteps?: number;
}

export interface PlanSnapshotRecord extends CreatePlanSnapshotInput {
  createdAt: string;
}

// ── Repository ────────────────────────────────────────────────────────────

export class PlanSnapshotRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreatePlanSnapshotInput): Promise<PlanSnapshotRecord> {
    const result = await this.pool.query(
      `INSERT INTO plan_snapshots (
        id, run_id, plan_id, version, event_type,
        plan_json, diff_summary, trigger,
        added_steps, removed_steps, modified_steps
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING created_at`,
      [
        input.id,
        input.runId,
        input.planId,
        input.version,
        input.eventType,
        JSON.stringify(input.planJson),
        input.diffSummary ?? null,
        input.trigger ?? null,
        input.addedSteps ?? 0,
        input.removedSteps ?? 0,
        input.modifiedSteps ?? 0,
      ],
    );
    return { ...input, createdAt: result.rows[0]?.created_at as string };
  }

  async listByRunId(runId: string): Promise<PlanSnapshotRecord[]> {
    const result = await this.pool.query(
      `SELECT id, run_id, plan_id, version, event_type,
              plan_json, diff_summary, trigger,
              added_steps, removed_steps, modified_steps, created_at
       FROM plan_snapshots WHERE run_id = $1
       ORDER BY version ASC`,
      [runId],
    );
    return result.rows.map(rowToSnapshot);
  }

  async getLatest(planId: string): Promise<PlanSnapshotRecord | null> {
    const result = await this.pool.query(
      `SELECT id, run_id, plan_id, version, event_type,
              plan_json, diff_summary, trigger,
              added_steps, removed_steps, modified_steps, created_at
       FROM plan_snapshots WHERE plan_id = $1
       ORDER BY version DESC LIMIT 1`,
      [planId],
    );
    if (result.rows.length === 0) return null;
    return rowToSnapshot(result.rows[0]);
  }

  async updateRunPlanState(
    runId: string,
    planJson: Record<string, unknown>,
    revisionCount: number,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE runs SET active_plan_json = $1, plan_revision_count = $2
       WHERE id = $3`,
      [JSON.stringify(planJson), revisionCount, runId],
    );
  }
}

function rowToSnapshot(row: Record<string, unknown>): PlanSnapshotRecord {
  return {
    id: row["id"] as string,
    runId: row["run_id"] as string,
    planId: row["plan_id"] as string,
    version: row["version"] as number,
    eventType: row["event_type"] as PlanSnapshotRecord["eventType"],
    planJson: (row["plan_json"] as Record<string, unknown>) ?? {},
    diffSummary: (row["diff_summary"] as string) ?? undefined,
    trigger: (row["trigger"] as string) ?? undefined,
    addedSteps: (row["added_steps"] as number) ?? 0,
    removedSteps: (row["removed_steps"] as number) ?? 0,
    modifiedSteps: (row["modified_steps"] as number) ?? 0,
    createdAt: row["created_at"] as string,
  };
}
