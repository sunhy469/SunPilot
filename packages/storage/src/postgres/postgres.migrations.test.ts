import { describe, expect, test } from "vitest";
import { listPostgresMigrationFiles } from "./postgres.migrations.js";

describe("PostgreSQL migration discovery", () => {
  test("discovers every contiguous migration in numeric order", async () => {
    const files = await listPostgresMigrationFiles();

    expect(files.at(-2)).toBe("022_digital_world_foreign_keys.sql");
    expect(files.at(-1)).toBe("023_world_actions_agent_run_index.sql");
    expect(files).toHaveLength(23);
  });
});
