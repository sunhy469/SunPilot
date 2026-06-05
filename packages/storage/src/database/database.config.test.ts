import { describe, expect, test } from "vitest";
import { DEFAULT_POSTGRES_URL, readDatabaseConfig } from "./database.config.js";

describe("readDatabaseConfig", () => {
  test("uses PostgreSQL defaults", () => {
    expect(readDatabaseConfig({})).toEqual({
      provider: "postgres",
      url: DEFAULT_POSTGRES_URL
    });
  });

  test("rejects SQLite provider configuration", () => {
    expect(() => readDatabaseConfig({ SUNPILOT_DATABASE_PROVIDER: "sqlite" })).toThrow('SUNPILOT_DATABASE_PROVIDER must be "postgres"');
  });
});
