import { createPostgresPool, PostgresDatabaseContext, runPostgresMigrations } from "../postgres/index.js";
import { readDatabaseConfig, type DatabaseConfig } from "./database.config.js";
import type { DatabaseContext } from "./database.types.js";

export async function createDatabaseContext(config: DatabaseConfig = readDatabaseConfig()): Promise<DatabaseContext> {
  const pool = createPostgresPool(config);
  await runPostgresMigrations(pool);
  return new PostgresDatabaseContext(pool);
}
