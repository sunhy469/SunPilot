/**
 * Runtime environment validation for SunPilot.
 *
 * Replaces ad-hoc `Number(process.env.X ?? default)` reads that silently
 * produce `NaN` for invalid input (e.g. `SUNPILOT_SKILL_MAX_CONCURRENCY=abc`).
 * Invalid values now fail fast with a clear zod error at daemon startup.
 *
 * Numeric fields use `z.coerce.number()` which throws on non-numeric input
 * (NaN is rejected by zod). Missing values fall back to the documented
 * defaults via `.default(...)`.
 */
import { z } from "zod";

export const envSchema = z.object({
  SUNPILOT_HOME: z.string().optional(),

  SUNPILOT_PORT: z.coerce.number().default(3737),
  SUNPILOT_WEB_URL: z.string().optional(),
  SUNPILOT_CONSOLE_URL: z.string().default("https://tradeagent.asia"),
  SUNPILOT_ALLOWED_ORIGINS: z.string().default(""),
  SUNPILOT_LOG_LEVEL: z.string().default("info"),
  SUNPILOT_DISABLE_TOKEN_AUTH: z.string().optional(),

  SUNPILOT_SKILL_TIMEOUT_MS: z.coerce.number().default(5 * 60_000),
  SUNPILOT_SKILL_MAX_CONCURRENCY: z.coerce.number().default(4),
  SUNPILOT_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(10_000),
  SUNPILOT_RATE_LIMIT_MAX: z.coerce.number().default(200),

  SUNPILOT_DATABASE_PROVIDER: z.string().default("postgres"),
  SUNPILOT_DATABASE_URL: z.string().default(
    "postgresql://sunpilot:sunpilot_dev_password@localhost:5432/sunpilot",
  ),
  SUNPILOT_POSTGRES_PORT: z.coerce.number().default(5432),

  SUNPILOT_LLM_BASE_URL: z.string().default("https://api.deepseek.com"),
  SUNPILOT_LLM_MODEL: z.string().default("deepseek-v4-flash"),
  SUNPILOT_LLM_API_KEY: z.string().optional(),
  DEEPSEEK_API_KEY: z.string().optional(),

  SUNPILOT_DP_LLM_BASE_URL: z.string().optional(),
  SUNPILOT_DP_LLM_MODEL: z.string().optional(),
  SUNPILOT_DP_LLM_API_KEY: z.string().optional(),

  SUNPILOT_SEED_LLM_BASE_URL: z
    .string()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  SUNPILOT_SEED_LLM_MODEL: z.string().default("doubao-seed-2-0-lite-260428"),
  SUNPILOT_SEED_LLM_API_KEY: z.string().optional(),

  // Only 1536 is supported: the pgvector schema (migration 014) uses
  // vector(1536), and switching dimensions requires a coordinated migration
  // + model change. Non-1536 values are rejected to prevent silent
  // service/provider/schema mismatch.
  SUNPILOT_EMBEDDING_DIMENSIONS: z
    .coerce.number()
    .default(1536)
    .refine((n) => n === 1536, "SUNPILOT_EMBEDDING_DIMENSIONS must be 1536 (the only supported dimension; DB column is vector(1536))"),
  SUNPILOT_EMBEDDING_MODEL: z.string().optional(),

  SUNPILOT_SANDBOX_MODE: z
    .enum(["strict", "moderate", "permissive"])
    .default("moderate"),

  /** §P3: Minimum cosine similarity for Layer 1 embedding short-circuit.
   *  Lower values increase short-circuit rate at the cost of potential
   *  false positives. Clamped to [0.75, 0.98] at runtime. Default: 0.95. */
  SUNPILOT_INTENT_EMBEDDING_THRESHOLD: z.string().default("0.95"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate a raw environment object (defaults to `process.env`).
 * Throws a zod error listing every invalid field — exported so tests can
 * validate synthetic environments.
 */
export function parseEnv(rawEnv: NodeJS.ProcessEnv = process.env): Env {
  return envSchema.parse(rawEnv);
}

/**
 * Validated, ready-to-use environment snapshot for the current process.
 * Parsed once at module load. Callers that need to honor runtime env
 * mutations (e.g. tests flipping `SUNPILOT_DISABLE_TOKEN_AUTH`) should call
 * `parseEnv(process.env)` at call time instead.
 */
export const env: Env = parseEnv(process.env);
