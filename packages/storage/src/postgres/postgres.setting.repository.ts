import type { SettingRecord, SettingRepository } from "../repositories/setting.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresSettingRepository implements SettingRepository {
  constructor(private readonly pool: PostgresPool) {}

  async set(key: string, value: unknown): Promise<SettingRecord> {
    const result = await this.pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value ?? null)]
    );
    return mapSetting(result.rows[0]);
  }

  async get(key: string): Promise<SettingRecord | null> {
    const result = await this.pool.query("SELECT key, value, updated_at FROM settings WHERE key = $1", [key]);
    return result.rows[0] ? mapSetting(result.rows[0]) : null;
  }
}

function mapSetting(row: any): SettingRecord {
  return {
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at.toISOString()
  };
}
