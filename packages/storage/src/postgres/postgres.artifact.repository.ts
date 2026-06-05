import type { ArtifactRecord, ArtifactType } from "@sunpilot/protocol";
import type { ArtifactRepository } from "../repositories/artifact.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    const result = await this.pool.query(
      `INSERT INTO artifacts (id, run_id, step_id, type, name, path, mime_type, size_bytes, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
       RETURNING id, run_id, step_id, type, name, path, mime_type, size_bytes, metadata, created_at`,
      [input.id, input.runId, input.stepId ?? null, input.type, input.name, input.path, input.mimeType ?? null, input.sizeBytes ?? null, JSON.stringify(input.metadata ?? {}), input.createdAt]
    );
    return mapArtifact(result.rows[0]);
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    const result = await this.pool.query("SELECT id, run_id, step_id, type, name, path, mime_type, size_bytes, metadata, created_at FROM artifacts WHERE id = $1", [id]);
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  }

  async list(runId?: string): Promise<ArtifactRecord[]> {
    const result = runId
      ? await this.pool.query("SELECT id, run_id, step_id, type, name, path, mime_type, size_bytes, metadata, created_at FROM artifacts WHERE run_id = $1 ORDER BY created_at DESC", [runId])
      : await this.pool.query("SELECT id, run_id, step_id, type, name, path, mime_type, size_bytes, metadata, created_at FROM artifacts ORDER BY created_at DESC");
    return result.rows.map(mapArtifact);
  }
}

function mapArtifact(row: any): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    type: row.type as ArtifactType,
    name: row.name,
    path: row.path,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString()
  };
}
