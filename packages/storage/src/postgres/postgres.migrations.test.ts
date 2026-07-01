import { describe, expect, test } from "vitest";
import { listPostgresMigrationFiles } from "./postgres.migrations.js";

describe("PostgreSQL migration discovery", () => {
  test("discovers every contiguous migration in numeric order", async () => {
    const files = await listPostgresMigrationFiles();

    expect(files.at(-3)).toBe("023_world_actions_agent_run_index.sql");
    expect(files.at(-2)).toBe("024_react_trace_metadata.sql");
    expect(files.at(-1)).toBe("025_agent_event_outbox.sql");
    expect(files).toHaveLength(25);
  });
});
