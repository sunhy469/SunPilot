import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresPool } from "./postgres.client.js";

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const migrationFiles = ["001_init.sql", "002_conversations.sql", "003_messages.sql", "004_runtime_aux.sql", "005_runtime_steps_jobs.sql", "006_catalog.sql"];
const migrationLockKey = 7_290_317_373_001;

export async function runPostgresMigrations(pool: PostgresPool): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query("SELECT pg_advisory_lock($1)", [migrationLockKey]);
    locked = true;
    for (const file of migrationFiles) {
      const version = file.replace(/\.sql$/, "");
      const applied = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]);
      if (applied.rowCount && applied.rowCount > 0) continue;
      const sql = await readFile(join(migrationDir, file), "utf8");
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      if (locked) await client.query("SELECT pg_advisory_unlock($1)", [migrationLockKey]);
    } finally {
      client.release();
    }
  }
}
