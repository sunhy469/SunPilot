import type { ArtifactRecord, ArtifactType } from "@sunpilot/protocol";
import type { ArtifactRepository } from "../repositories/artifact.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresArtifactRepository implements ArtifactRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: ArtifactRecord): Promise<ArtifactRecord> {
    const result = await this.pool.query(
      `INSERT INTO artifacts (
         id, run_id, step_id, conversation_id, type, name, path, storage_key,
         checksum, version, mime_type, size_bytes, metadata, created_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 1), $11, $12, $13::jsonb, $14)
       RETURNING ${ARTIFACT_COLUMNS}`,
      [
        input.id,
        input.runId,
        input.stepId ?? null,
        input.conversationId ?? null,
        input.type,
        input.name,
        input.path,
        input.storageKey ?? null,
        input.checksum ?? null,
        input.version ?? 1,
        input.mimeType ?? null,
        input.sizeBytes ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.createdAt,
      ],
    );
    return mapArtifact(result.rows[0]);
  }

  async findById(id: string): Promise<ArtifactRecord | null> {
    const result = await this.pool.query(
      `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? mapArtifact(result.rows[0]) : null;
  }

  async list(runId?: string): Promise<ArtifactRecord[]> {
    const result = runId
      ? await this.pool.query(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE run_id = $1 ORDER BY created_at DESC`,
          [runId],
        )
      : await this.pool.query(
          `SELECT ${ARTIFACT_COLUMNS} FROM artifacts ORDER BY created_at DESC`,
        );
    return result.rows.map(mapArtifact);
  }
}

const ARTIFACT_COLUMNS = [
  "id",
  "run_id",
  "step_id",
  "conversation_id",
  "type",
  "name",
  "path",
  "storage_key",
  "checksum",
  "version",
  "mime_type",
  "size_bytes",
  "metadata",
  "created_at",
].join(", ");

function mapArtifact(row: any): ArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    type: row.type as ArtifactType,
    name: row.name,
    path: row.path,
    storageKey: row.storage_key ?? undefined,
    checksum: row.checksum ?? undefined,
    version: row.version ?? undefined,
    mimeType: row.mime_type ?? undefined,
    sizeBytes: row.size_bytes ?? undefined,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
  };
}
