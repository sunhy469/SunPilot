import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "../testing/in-memory-database.context.js";

const now = "2026-06-06T00:00:00.000Z";

describe("memory repository", () => {
  test("searches only visible memory scopes", async () => {
    const db = new InMemoryDatabaseContext();
    await db.memory.create({
      id: "memory_global",
      key: "stack",
      value: "SunPilot uses TypeScript",
      scope: "global",
      type: "technical_stack",
      metadata: {},
      createdAt: now,
    });
    await db.memory.create({
      id: "memory_user_a",
      key: "preference",
      value: "prefers concise Chinese answers",
      scope: "user",
      scopeId: "user_a",
      type: "user_preference",
      metadata: {},
      createdAt: now,
    });
    await db.memory.create({
      id: "memory_user_b",
      key: "preference",
      value: "prefers verbose answers",
      scope: "user",
      scopeId: "user_b",
      type: "user_preference",
      metadata: {},
      createdAt: now,
    });

    const memories = await db.memory.search({
      query: "prefers",
      userId: "user_a",
    });

    expect(memories.map((memory) => memory.id)).toEqual(["memory_user_a"]);
  });

  test("filters superseded and soft-deleted memories", async () => {
    const db = new InMemoryDatabaseContext();
    await db.memory.create({
      id: "memory_old",
      key: "deployment",
      value: "old deployment note",
      scope: "global",
      type: "deployment_info",
      metadata: {},
      createdAt: now,
    });
    await db.memory.create({
      id: "memory_new",
      key: "deployment",
      value: "new deployment note",
      scope: "global",
      type: "deployment_info",
      metadata: {},
      createdAt: now,
    });
    await db.memory.create({
      id: "memory_deleted",
      key: "deployment",
      value: "deleted deployment note",
      scope: "global",
      type: "deployment_info",
      metadata: {},
      createdAt: now,
    });

    await db.memory.supersede("memory_old", "memory_new");
    await db.memory.softDelete(
      "memory_deleted",
      "user_requested",
      "2026-06-06T00:01:00.000Z",
    );

    expect(
      (await db.memory.search({ query: "deployment" })).map(
        (memory) => memory.id,
      ),
    ).toEqual(["memory_new"]);
    expect(
      (await db.memory.list({ includeDeleted: true })).map(
        (memory) => memory.id,
      ),
    ).toContain("memory_deleted");
  });

  test("normalizes legacy run memory records", async () => {
    const db = new InMemoryDatabaseContext();
    const memory = await db.memory.create({
      id: "memory_legacy",
      runId: "run_1",
      stepId: "step_1",
      key: "result",
      value: { ok: true },
      metadata: {},
      createdAt: now,
    });

    expect(memory).toMatchObject({
      scope: "run",
      scopeId: "run_1",
      type: "manual_note",
      title: "result",
      source: "runtime",
    });
    expect(
      await db.memory.search({ query: "ok", runId: "run_1" }),
    ).toHaveLength(1);
  });

  test("updates memory metadata and searchable content", async () => {
    const db = new InMemoryDatabaseContext();
    await db.memory.create({
      id: "memory_patch",
      key: "stack",
      value: "old stack",
      scope: "global",
      type: "technical_stack",
      metadata: {},
      createdAt: now,
    });

    const updated = await db.memory.update("memory_patch", {
      value: "TypeScript and PostgreSQL",
      title: "Current stack",
      content: "TypeScript and PostgreSQL",
      metadata: { source: "patch" },
    });

    expect(updated).toMatchObject({
      id: "memory_patch",
      key: "stack",
      title: "Current stack",
      content: "TypeScript and PostgreSQL",
      metadata: { source: "patch" },
    });
    expect(
      (await db.memory.search({ query: "PostgreSQL" })).map(
        (memory) => memory.id,
      ),
    ).toEqual(["memory_patch"]);
  });
});
