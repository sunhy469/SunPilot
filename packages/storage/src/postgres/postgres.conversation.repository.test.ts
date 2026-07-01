import { describe, expect, test, vi } from "vitest";
import { PostgresConversationRepository } from "./postgres.conversation.repository.js";

describe("PostgresConversationRepository", () => {
  test("reuses a transaction-scoped client instead of opening a nested transaction", async () => {
    const query = vi.fn(async (text: string) => ({
      rows: [],
      rowCount: text.includes("DELETE FROM conversations") ? 1 : 0,
    }));
    const repository = new PostgresConversationRepository({ query } as never);

    await expect(repository.delete("conv_1")).resolves.toBe(true);

    expect(query).toHaveBeenCalled();
    expect(query.mock.calls.map(([text]) => text)).not.toContain("BEGIN");
    expect(query.mock.calls.some(([text]) =>
      text.includes("DELETE FROM conversations"),
    )).toBe(true);
  });

  test("locks a conversation row for guarded deletion", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new PostgresConversationRepository({ query } as never);

    await repository.findByIdForUpdate("conv_1");

    expect(query.mock.calls[0]?.[0]).toContain("FOR UPDATE");
  });
});
