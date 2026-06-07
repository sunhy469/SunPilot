import { createPostgresPool, PostgresDatabaseContext, runPostgresMigrations } from "../postgres/index.js";
import { readDatabaseConfig, type DatabaseConfig } from "./database.config.js";
import type { DatabaseContext } from "./database.types.js";

/**
 * 创建数据库上下文 — 当前仅支持 PostgreSQL。
 *
 * 流程：
 * 1. 读取配置（环境变量 / config 文件）
 * 2. 创建 pg Pool（连接池管理）
 * 3. 自动运行迁移（postgres.migrations.ts）
 * 4. 返回 PostgresDatabaseContext（包含所有 repository 实例）
 *
 * DatabaseContext 接口定义了所有 repository 的抽象合约，
 * PostgresDatabaseContext 是唯一的实现。
 */
export async function createDatabaseContext(config: DatabaseConfig = readDatabaseConfig()): Promise<DatabaseContext> {
  const pool = createPostgresPool(config);
  await runPostgresMigrations(pool);
  return new PostgresDatabaseContext(pool);
}
