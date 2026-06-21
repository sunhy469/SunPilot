import type {
  WorldNodeRecord,
  CreateWorldNodeInput,
  WorldNodeRepository,
} from "../repositories/world-node.repository.js";
import type { PostgresPool } from "./postgres.client.js";

const NODE_COLUMNS = `
  id, type, name, pos_x, pos_y, size_width, size_height, icon, logo, enabled, created_at
`;

function mapNode(row: Record<string, unknown>): WorldNodeRecord {
  return {
    id: row["id"] as string,
    type: row["type"] as string,
    name: row["name"] as string,
    posX: row["pos_x"] as number,
    posY: row["pos_y"] as number,
    sizeWidth: row["size_width"] as number,
    sizeHeight: row["size_height"] as number,
    icon: (row["icon"] as string) ?? undefined,
    logo: (row["logo"] as string) ?? undefined,
    enabled: (row["enabled"] as boolean) ?? true,
    createdAt: row["created_at"] as string,
  };
}

export class PostgresWorldNodeRepository implements WorldNodeRepository {
  constructor(private readonly pool: PostgresPool) {}

  async create(input: CreateWorldNodeInput): Promise<WorldNodeRecord> {
    const id = input.id ?? `node_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const result = await this.pool.query(
      `INSERT INTO world_nodes (id, type, name, pos_x, pos_y, size_width, size_height, icon, logo, enabled, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${NODE_COLUMNS}`,
      [
        id,
        input.type,
        input.name,
        input.posX,
        input.posY,
        input.sizeWidth,
        input.sizeHeight,
        input.icon ?? null,
        input.logo ?? null,
        input.enabled ?? true,
        now,
      ],
    );
    return mapNode(result.rows[0]);
  }

  async findById(id: string): Promise<WorldNodeRecord | null> {
    const result = await this.pool.query(
      `SELECT ${NODE_COLUMNS} FROM world_nodes WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return mapNode(result.rows[0]);
  }

  async list(): Promise<WorldNodeRecord[]> {
    const result = await this.pool.query(
      `SELECT ${NODE_COLUMNS} FROM world_nodes ORDER BY created_at ASC`,
    );
    return result.rows.map(mapNode);
  }

  async update(id: string, patch: Partial<CreateWorldNodeInput>): Promise<WorldNodeRecord | null> {
    const sets: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    const fields: Record<string, unknown> = {
      type: patch.type,
      name: patch.name,
      pos_x: patch.posX,
      pos_y: patch.posY,
      size_width: patch.sizeWidth,
      size_height: patch.sizeHeight,
      icon: patch.icon,
      logo: patch.logo,
      enabled: patch.enabled,
    };

    for (const [column, value] of Object.entries(fields)) {
      if (value !== undefined) {
        sets.push(`${column} = $${idx}`);
        values.push(value);
        idx++;
      }
    }

    if (sets.length === 0) return this.findById(id);

    values.push(id);
    const result = await this.pool.query(
      `UPDATE world_nodes SET ${sets.join(", ")} WHERE id = $${idx} RETURNING ${NODE_COLUMNS}`,
      values,
    );
    if (result.rows.length === 0) return null;
    return mapNode(result.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM world_nodes WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
