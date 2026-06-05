export const DATABASE_PROVIDER_ENV = "SUNPILOT_DATABASE_PROVIDER";
export const DATABASE_URL_ENV = "SUNPILOT_DATABASE_URL";
export const DEFAULT_DATABASE_PROVIDER = "postgres";
export const DEFAULT_POSTGRES_URL = "postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot";

export interface DatabaseConfig {
  provider: "postgres";
  url: string;
}

export function readDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const provider = env[DATABASE_PROVIDER_ENV] ?? DEFAULT_DATABASE_PROVIDER;
  if (provider !== "postgres") {
    throw new Error(`${DATABASE_PROVIDER_ENV} must be "postgres". SQLite is no longer a supported database provider.`);
  }
  return {
    provider,
    url: env[DATABASE_URL_ENV] ?? DEFAULT_POSTGRES_URL
  };
}
