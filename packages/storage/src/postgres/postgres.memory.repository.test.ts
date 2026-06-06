import { describe, expect, test } from "vitest";
import { PostgresMemoryRepository } from "./postgres.memory.repository.js";

describe("PostgresMemoryRepository", () => {
  test("does not expose private scoped memories without a matching subject id", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const repository = new PostgresMemoryRepository({
      query: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
    } as any);

    await repository.search({ scopes: ["user"], query: "secret" });

    expect(queries[0]?.text).toContain("FALSE");
    expect(queries[0]?.text).not.toContain("scope = ANY");
  });

  test("keeps globally scoped memory visible without a subject id", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    const repository = new PostgresMemoryRepository({
      query: async (text: string, values: unknown[]) => {
        queries.push({ text, values });
        return { rows: [] };
      },
    } as any);

    await repository.search({ scopes: ["global"], query: "stack" });

    expect(queries[0]?.text).toContain("scope = 'global'");
    expect(queries[0]?.text).not.toContain("FALSE");
  });
});
