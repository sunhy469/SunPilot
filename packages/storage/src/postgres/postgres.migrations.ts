import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresPool } from "./postgres.client.js";

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const migrationLockKey = 7_290_317_373_001;

export async function listPostgresMigrationFiles(): Promise<string[]> {
  const files = (await readdir(migrationDir))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/i.test(file))
    .sort((left, right) => left.localeCompare(right));

  for (let index = 0; index < files.length; index += 1) {
    const expectedPrefix = String(index + 1).padStart(3, "0");
    if (!files[index]?.startsWith(`${expectedPrefix}_`)) {
      throw new Error(
        `PostgreSQL migrations must be contiguous: expected ${expectedPrefix}, found ${files[index] ?? "end of list"}.`,
      );
    }
  }
  return files;
}

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
    const migrationFiles = await listPostgresMigrationFiles();
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
