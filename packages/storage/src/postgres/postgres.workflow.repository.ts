import type { WorkflowRecord } from "@sunpilot/protocol";
import type { WorkflowRepository } from "../repositories/workflow.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresWorkflowRepository implements WorkflowRepository {
  constructor(private readonly pool: PostgresPool) {}

  async upsert(input: WorkflowRecord): Promise<WorkflowRecord> {
    const result = await this.pool.query(
      `INSERT INTO workflows (id, title, version, source, enabled, definition, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         version = EXCLUDED.version,
         source = EXCLUDED.source,
         enabled = EXCLUDED.enabled,
         definition = EXCLUDED.definition,
         updated_at = EXCLUDED.updated_at
       RETURNING id, title, version, source, enabled, definition, created_at, updated_at`,
      [input.id, input.title, input.version, input.source, input.enabled, JSON.stringify(input.definition ?? {}), input.createdAt, input.updatedAt]
    );
    return mapWorkflow(result.rows[0]);
  }

  async list(): Promise<WorkflowRecord[]> {
    const result = await this.pool.query("SELECT id, title, version, source, enabled, definition, created_at, updated_at FROM workflows ORDER BY id");
    return result.rows.map(mapWorkflow);
  }

  async findById(id: string): Promise<WorkflowRecord | null> {
    const result = await this.pool.query("SELECT id, title, version, source, enabled, definition, created_at, updated_at FROM workflows WHERE id = $1", [id]);
    return result.rows[0] ? mapWorkflow(result.rows[0]) : null;
  }
}

function mapWorkflow(row: any): WorkflowRecord {
  return {
    id: row.id,
    title: row.title,
    version: row.version,
    source: row.source,
    enabled: row.enabled,
    definition: row.definition ?? {},
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
