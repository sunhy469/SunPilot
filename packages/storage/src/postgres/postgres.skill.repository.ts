import type { InstalledSkillRecord, SkillManifest } from "@sunpilot/protocol";
import type { SkillRepository } from "../repositories/skill.repository.js";
import type { PostgresPool } from "./postgres.client.js";

export class PostgresSkillRepository implements SkillRepository {
  constructor(private readonly pool: PostgresPool) {}

  async upsert(input: InstalledSkillRecord): Promise<InstalledSkillRecord> {
    const result = await this.pool.query(
      `INSERT INTO installed_skills (id, name, version, path, enabled, manifest, readme_summary, installed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         version = EXCLUDED.version,
         path = EXCLUDED.path,
         enabled = EXCLUDED.enabled,
         manifest = EXCLUDED.manifest,
         readme_summary = EXCLUDED.readme_summary,
         updated_at = EXCLUDED.updated_at
       RETURNING id, name, version, path, enabled, manifest, readme_summary, installed_at, updated_at`,
      [input.id, input.name, input.version, input.path, input.enabled, JSON.stringify(input.manifest), input.readmeSummary ?? null, input.installedAt, input.updatedAt]
    );
    return mapSkill(result.rows[0]);
  }

  async list(): Promise<InstalledSkillRecord[]> {
    const result = await this.pool.query("SELECT id, name, version, path, enabled, manifest, readme_summary, installed_at, updated_at FROM installed_skills ORDER BY id");
    return result.rows.map(mapSkill);
  }

  async findById(id: string): Promise<InstalledSkillRecord | null> {
    const result = await this.pool.query("SELECT id, name, version, path, enabled, manifest, readme_summary, installed_at, updated_at FROM installed_skills WHERE id = $1", [id]);
    return result.rows[0] ? mapSkill(result.rows[0]) : null;
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledSkillRecord | null> {
    const result = await this.pool.query(
      `UPDATE installed_skills SET enabled = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, name, version, path, enabled, manifest, readme_summary, installed_at, updated_at`,
      [enabled, id]
    );
    return result.rows[0] ? mapSkill(result.rows[0]) : null;
  }
}

function mapSkill(row: any): InstalledSkillRecord {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    path: row.path,
    enabled: row.enabled,
    manifest: row.manifest as SkillManifest,
    readmeSummary: row.readme_summary ?? undefined,
    installedAt: row.installed_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
