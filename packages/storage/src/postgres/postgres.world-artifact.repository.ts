import type {
  WorldArtifactRecord,
  CreateWorldArtifactInput,
  UpdateWorldArtifactPatch,
  WorldArtifactRepository,
} from "../repositories/world-artifact.repository.js";
import type { PostgresPool } from "./postgres.client.js";

const ARTIFACT_COLUMNS = `
  id, being_id, task_id, run_id, type, title, uri, thumbnail_uri,
  location_node_id, status, metadata, created_at
`;

function mapArtifact(row: Record<string, unknown>): WorldArtifactRecord {
  return {
    id: row["id"] as string,
    beingId: row["being_id"] as string,
    taskId: (row["task_id"] as string) ?? undefined,
    runId: (row["run_id"] as string) ?? undefined,
    type: row["type"] as string,
    title: row["title"] as string,
    uri: (row["uri"] as string) ?? undefined,
    thumbnailUri: (row["thumbnail_uri"] as string) ?? undefined,
    locationNodeId: row["location_node_id"] as string,
    status: row["status"] as string,
    metadata: (row["metadata"] as Record<string, unknown>) ?? {},
    createdAt: row["created_at"] as string,
  };
}

export class PostgresWorldArtifactRepository implements WorldArtifactRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateWorldArtifactInput): Promise<WorldArtifactRecord> {
    const id = input.id ?? `wart_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO world_artifacts (id, being_id, task_id, run_id, type, title, uri, thumbnail_uri, location_node_id, status, metadata, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING ${ARTIFACT_COLUMNS}`,
      [
        id,
        input.beingId,
        input.taskId ?? null,
        input.runId ?? null,
        input.type,
        input.title,
        input.uri ?? null,
        input.thumbnailUri ?? null,
        input.locationNodeId,
        input.status ?? "created",
        JSON.stringify(input.metadata ?? {}),
        now,
      ],
    );
    return mapArtifact(result.rows[0]);
  }

  async findById(id: string): Promise<WorldArtifactRecord | null> {
    const result = await this.pool.query(
      `SELECT ${ARTIFACT_COLUMNS} FROM world_artifacts WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapArtifact(result.rows[0]);
  }

  async listByBeingId(beingId: string): Promise<WorldArtifactRecord[]> {
    const result = await this.pool.query(
      `SELECT ${ARTIFACT_COLUMNS} FROM world_artifacts WHERE being_id = $1 ORDER BY created_at DESC`,
      [beingId],
    );
    return result.rows.map(mapArtifact);
  }

  async update(id: string, patch: UpdateWorldArtifactPatch): Promise<WorldArtifactRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const fields: Record<string, unknown> = {
      status: patch.status,
      uri: patch.uri,
      thumbnail_uri: patch.thumbnailUri,
      metadata: patch.metadata ? JSON.stringify(patch.metadata) : undefined,
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
      `UPDATE world_artifacts SET ${sets.join(", ")} WHERE id = $${idx} RETURNING ${ARTIFACT_COLUMNS}`,
      values,
    );
    if (result.rows.length === 0) return null;
    return mapArtifact(result.rows[0]);
  }
}
