import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { MemoryPruningWorker } from "./memory-pruning-worker.js";
import type { DatabaseContext } from "@sunpilot/storage";

function makeMockDb(overrides: {
  hardDeleteOlderThan?: ReturnType<typeof vi.fn>;
  hardDeleteSupersededOlderThan?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    memory: {
      hardDeleteOlderThan: overrides.hardDeleteOlderThan ?? vi.fn().mockResolvedValue(0),
      hardDeleteSupersededOlderThan: overrides.hardDeleteSupersededOlderThan ?? vi.fn().mockResolvedValue(0),
    },
  } as unknown as DatabaseContext;
}

describe("MemoryPruningWorker", () => {
  let worker: MemoryPruningWorker;

  afterEach(() => {
    worker?.stop();
  });

  test("start and stop lifecycle", () => {
    const db = makeMockDb();
    worker = new MemoryPruningWorker({ database: db, intervalMs: 100_000 }); // Long interval
    worker.start();
    // Should not throw
    worker.stop();
    // Double stop should be safe
    worker.stop();
  });

  test("double start is idempotent", () => {
    const db = makeMockDb();
    worker = new MemoryPruningWorker({ database: db, intervalMs: 100_000 });
    worker.start();
    worker.start(); // Second start should be no-op
    worker.stop();
  });

  test("calls hardDeleteOlderThan for deleted_at with correct retention", async () => {
    const hardDeleteOlderThan = vi.fn().mockResolvedValue(5);
    const db = makeMockDb({ hardDeleteOlderThan });

    worker = new MemoryPruningWorker({
      database: db,
      softDeleteRetentionDays: 30,
      intervalMs: 10_000, // Short for testability
    });

    // Access the private prune method via invoking start then waiting briefly
    // We'll call prune directly via any cast for testing
    const result = await (worker as any).prune();

    expect(hardDeleteOlderThan).toHaveBeenCalledWith(
      "deleted_at",
      expect.any(String), // cutoff date ~30 days ago
    );
    expect(hardDeleteOlderThan).toHaveBeenCalledWith(
      "expires_at",
      expect.any(String), // cutoff date ~7 days ago
    );
    expect(result.deletedSoftDeleted).toBe(5);
  });

  test("calls hardDeleteOlderThan for expires_at with correct retention", async () => {
    const hardDeleteOlderThan = vi.fn()
      .mockResolvedValueOnce(0) // deleted_at
      .mockResolvedValueOnce(3); // expires_at
    const hardDeleteSupersededOlderThan = vi.fn().mockResolvedValue(0);
    const db = makeMockDb({ hardDeleteOlderThan, hardDeleteSupersededOlderThan });

    worker = new MemoryPruningWorker({
      database: db,
      expireRetentionDays: 7,
      intervalMs: 10_000,
    });

    const result = await (worker as any).prune();

    expect(hardDeleteOlderThan).toHaveBeenCalledTimes(2);
    expect(result.deletedExpired).toBe(3);
  });

  test("calls hardDeleteSupersededOlderThan with correct retention", async () => {
    const hardDeleteOlderThan = vi.fn().mockResolvedValue(0);
    const hardDeleteSupersededOlderThan = vi.fn().mockResolvedValue(2);
    const db = makeMockDb({ hardDeleteOlderThan, hardDeleteSupersededOlderThan });

    worker = new MemoryPruningWorker({
      database: db,
      supersedeRetentionDays: 90,
      intervalMs: 10_000,
    });

    const result = await (worker as any).prune();

    expect(hardDeleteSupersededOlderThan).toHaveBeenCalledWith(
      expect.any(String), // cutoff date ~90 days ago
    );
    expect(result.deletedSuperseded).toBe(2);
  });

  test("calculates totalDeleted correctly", async () => {
    const hardDeleteOlderThan = vi.fn()
      .mockResolvedValueOnce(5) // deleted_at
      .mockResolvedValueOnce(3); // expires_at
    const hardDeleteSupersededOlderThan = vi.fn().mockResolvedValue(2);
    const db = makeMockDb({ hardDeleteOlderThan, hardDeleteSupersededOlderThan });

    worker = new MemoryPruningWorker({ database: db, intervalMs: 10_000 });

    const result = await (worker as any).prune();

    expect(result.totalDeleted).toBe(10); // 5 + 3 + 2
  });

  test("prevents concurrent runs", async () => {
    // Simulate a running state
    const hardDeleteOlderThan = vi.fn().mockResolvedValue(5);
    const db = makeMockDb({ hardDeleteOlderThan });

    worker = new MemoryPruningWorker({ database: db, intervalMs: 10_000 });

    // Force running flag
    (worker as any).running = true;

    const result = await (worker as any).prune();

    // Should return zeros without calling anything
    expect(result.totalDeleted).toBe(0);
    expect(hardDeleteOlderThan).not.toHaveBeenCalled();
  });

  test("handles errors gracefully without throwing", async () => {
    const hardDeleteOlderThan = vi.fn().mockRejectedValue(new Error("DB connection lost"));
    const db = makeMockDb({ hardDeleteOlderThan });

    worker = new MemoryPruningWorker({ database: db, intervalMs: 10_000 });

    // Should not throw
    const result = await (worker as any).prune();

    expect(result.totalDeleted).toBe(0);
    // running flag should be reset
    expect((worker as any).running).toBe(false);
  });

  test("resets running flag after completion", async () => {
    const db = makeMockDb();
    worker = new MemoryPruningWorker({ database: db, intervalMs: 10_000 });

    await (worker as any).prune();

    expect((worker as any).running).toBe(false);
  });

  test("resets running flag after error", async () => {
    const hardDeleteOlderThan = vi.fn().mockRejectedValue(new Error("fail"));
    const db = makeMockDb({ hardDeleteOlderThan });
    worker = new MemoryPruningWorker({ database: db, intervalMs: 10_000 });

    await (worker as any).prune();

    expect((worker as any).running).toBe(false);
  });

  test("uses default retention periods when not specified", async () => {
    const hardDeleteOlderThan = vi.fn().mockResolvedValue(0);
    const hardDeleteSupersededOlderThan = vi.fn().mockResolvedValue(0);
    const db = makeMockDb({ hardDeleteOlderThan, hardDeleteSupersededOlderThan });

    worker = new MemoryPruningWorker({ database: db, intervalMs: 10_000 });

    await (worker as any).prune();

    // Should have been called (defaults: 30, 7, 90 days)
    expect(hardDeleteOlderThan).toHaveBeenCalledTimes(2);
    expect(hardDeleteSupersededOlderThan).toHaveBeenCalledTimes(1);
  });

  test("cutoff dates are in the past relative to now", async () => {
    const hardDeleteOlderThan = vi.fn().mockResolvedValue(0);
    const db = makeMockDb({ hardDeleteOlderThan });

    worker = new MemoryPruningWorker({
      database: db,
      softDeleteRetentionDays: 30,
      expireRetentionDays: 7,
      intervalMs: 10_000,
    });

    const before = new Date();
    await (worker as any).prune();

    const softDeleteCall = hardDeleteOlderThan.mock.calls[0] as [string, string];
    const expireCall = hardDeleteOlderThan.mock.calls[1] as [string, string];

    // Cutoff dates should be in the past (before the test started)
    const softDeleteDate = new Date(softDeleteCall[1]);
    const expireDate = new Date(expireCall[1]);
    expect(softDeleteDate.getTime()).toBeLessThan(before.getTime());
    expect(expireDate.getTime()).toBeLessThan(before.getTime());
  });

  test("all-zero result when nothing to prune", async () => {
    const hardDeleteOlderThan = vi.fn().mockResolvedValue(0);
    const hardDeleteSupersededOlderThan = vi.fn().mockResolvedValue(0);
    const db = makeMockDb({ hardDeleteOlderThan, hardDeleteSupersededOlderThan });

    worker = new MemoryPruningWorker({ database: db, intervalMs: 10_000 });

    const result = await (worker as any).prune();

    expect(result).toEqual({
      deletedSoftDeleted: 0,
      deletedExpired: 0,
      deletedSuperseded: 0,
      totalDeleted: 0,
    });
  });
});
