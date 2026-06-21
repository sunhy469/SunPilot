import type {
  WorldEdgeRecord,
  CreateWorldEdgeInput,
  WorldEdgeRepository,
} from "../repositories/world-edge.repository.js";
import type { PostgresPool } from "./postgres.client.js";

const EDGE_COLUMNS = `id, from_node_id, to_node_id, distance, bidirectional, locked`;

function mapEdge(row: Record<string, unknown>): WorldEdgeRecord {
  return {
    id: row["id"] as string,
    fromNodeId: row["from_node_id"] as string,
    toNodeId: row["to_node_id"] as string,
    distance: (row["distance"] as number) ?? 1,
    bidirectional: (row["bidirectional"] as boolean) ?? true,
    locked: (row["locked"] as boolean) ?? false,
  };
}

export class PostgresWorldEdgeRepository implements WorldEdgeRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateWorldEdgeInput): Promise<WorldEdgeRecord> {
    const id = input.id ?? `edge_${crypto.randomUUID()}`;
    const result = await this.pool.query(
      `INSERT INTO world_edges (id, from_node_id, to_node_id, distance, bidirectional, locked)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${EDGE_COLUMNS}`,
      [
        id,
        input.fromNodeId,
        input.toNodeId,
        input.distance ?? 1,
        input.bidirectional ?? true,
        input.locked ?? false,
      ],
    );
    return mapEdge(result.rows[0]);
  }

  async findById(id: string): Promise<WorldEdgeRecord | null> {
    const result = await this.pool.query(
      `SELECT ${EDGE_COLUMNS} FROM world_edges WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapEdge(result.rows[0]);
  }

  async list(): Promise<WorldEdgeRecord[]> {
    const result = await this.pool.query(
      `SELECT ${EDGE_COLUMNS} FROM world_edges ORDER BY id ASC`,
    );
    return result.rows.map(mapEdge);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM world_edges WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
