import pg from "pg";
import type { DatabaseConfig } from "../database/database.config.js";

export type PostgresPool = pg.Pool;
export type PostgresClient = pg.PoolClient | pg.Pool;

export function createPostgresPool(config: DatabaseConfig): PostgresPool {
  return new pg.Pool({ connectionString: config.url });
}
