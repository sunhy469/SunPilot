import type { MemoryRecord } from "@sunpilot/protocol";
import type { ListMemoryInput, MemoryRepository } from "../repositories/memory.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: MemoryRecord): Promise<MemoryRecord> {
    const result = await this.pool.query(
      `INSERT INTO memory_metadata (id, run_id, step_id, key, value, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       RETURNING id, run_id, step_id, key, value, metadata, created_at`,
      [input.id, input.runId ?? null, input.stepId ?? null, input.key, JSON.stringify(input.value ?? null), JSON.stringify(input.metadata ?? {}), input.createdAt]
    );
    return mapMemory(result.rows[0]);
  }

  async list(input: ListMemoryInput = {}): Promise<MemoryRecord[]> {
    const clauses: string[] = [];
    const values: string[] = [];
    if (input.runId) {
      values.push(input.runId);
      clauses.push(`run_id = $${values.length}`);
    }
    if (input.key) {
      values.push(input.key);
      clauses.push(`key = $${values.length}`);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.pool.query(`SELECT id, run_id, step_id, key, value, metadata, created_at FROM memory_metadata${where} ORDER BY created_at DESC`, values);
    return result.rows.map(mapMemory);
  }
}

function mapMemory(row: any): MemoryRecord {
  return {
    id: row.id,
    runId: row.run_id ?? undefined,
    stepId: row.step_id ?? undefined,
    key: row.key,
    value: row.value,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString()
  };
}
