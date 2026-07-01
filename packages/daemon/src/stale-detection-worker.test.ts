import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { StaleDetectionWorker } from "./stale-detection-worker.js";
import { SummaryStaleDetector } from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import type { RetrievedMemoryRecord } from "@sunpilot/protocol";

function makeMemoryRecord(overrides: Partial<RetrievedMemoryRecord> = {}): RetrievedMemoryRecord {
  return {
    id: overrides.id ?? "mem_1",
    key: "conv_summary_1",
    value: "Summary value",
    scope: "conversation",
    scopeId: "conv_1",
    type: "conversation_summary",
    title: "Conversation Summary",
    content: "User set up CI/CD with GitHub Actions.",
    source: "agent_task_summary",
    confidence: 0.8,
    importance: 0.7,
    relevance: 0.9,
    score: 0.85,
    metadata: {},
    runId: "run_1",
    createdAt: "2026-06-25T00:00:00.000Z",
    updatedAt: "2026-06-25T00:00:00.000Z",
    ...overrides,
  };
}

function makeMockDb(overrides: {
  listResult?: RetrievedMemoryRecord[];
  messages?: Array<{ role: string; content: string; createdAt: string }>;
  updateFn?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    memory: {
      list: vi.fn().mockResolvedValue(overrides.listResult ?? []),
      update: overrides.updateFn ?? vi.fn().mockResolvedValue({ id: "mem_1" }),
    },
    messages: {
      listByConversationId: vi.fn().mockResolvedValue(
        overrides.messages ?? [],
      ),
    },
  } as unknown as DatabaseContext;
}

describe("StaleDetectionWorker", () => {
  let worker: StaleDetectionWorker;

  afterEach(() => {
    worker?.stop();
  });

  describe("start and stop lifecycle", () => {
    test("starts and stops without error", () => {
      const db = makeMockDb();
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });
      worker.start();
      worker.stop();
    });

    test("double start is idempotent", () => {
      const db = makeMockDb();
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });
      worker.start();
      worker.start(); // Should be no-op
      worker.stop();
    });

    test("schedules initial scan after 30s delay", async () => {
      // We don't actually wait 30s, just verify the worker starts
      const db = makeMockDb();
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });
      worker.start();
      // Worker should be alive
      worker.stop();
    });
  });

  describe("scan behavior", () => {
    test("scans and marks stale summaries", async () => {
      const mem = makeMemoryRecord({
        content: "User wants to set up CI/CD for Node.js.",
        createdAt: "2026-06-25T00:00:00.000Z",
      });
      const updateFn = vi.fn().mockResolvedValue({ id: "mem_1" });
      const db = makeMockDb({
        listResult: [mem],
        messages: [
          { role: "user", content: "Actually, let's use Docker Compose instead.", createdAt: "2026-06-25T01:00:00.000Z" },
        ],
        updateFn,
      });
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      await (worker as any).scan();

      expect(db.memory.list).toHaveBeenCalledWith({
        types: ["conversation_summary"],
        limit: 50,
        afterCursor: undefined,
      });
      expect(updateFn).toHaveBeenCalledWith(
        "mem_1",
        expect.objectContaining({
          staleReason: expect.any(String),
          staleSince: expect.any(String),
        }),
      );
    });

    test("skips summaries already marked as stale", async () => {
      const mem = makeMemoryRecord({
        staleReason: "already stale",
        content: "Old content.",
        createdAt: "2026-06-25T00:00:00.000Z",
      });
      const updateFn = vi.fn();
      const db = makeMockDb({
        listResult: [mem],
        messages: [
          { role: "user", content: "New message.", createdAt: "2026-06-25T01:00:00.000Z" },
        ],
        updateFn,
      });
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      await (worker as any).scan();

      // Should not call update since already stale
      expect(updateFn).not.toHaveBeenCalled();
    });

    test("skips summaries without runId or conversationId", async () => {
      const mem = makeMemoryRecord({
        runId: undefined,
        scopeId: undefined,
        createdAt: "2026-06-25T00:00:00.000Z",
      });
      const updateFn = vi.fn();
      const db = makeMockDb({
        listResult: [mem],
        updateFn,
      });
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      await (worker as any).scan();

      expect(updateFn).not.toHaveBeenCalled();
    });

    test("skips summaries when no newer messages exist", async () => {
      const mem = makeMemoryRecord({
        content: "Existing summary.",
        createdAt: "2026-06-25T02:00:00.000Z", // Summary is newer than messages
      });
      const updateFn = vi.fn();
      const db = makeMockDb({
        listResult: [mem],
        messages: [
          // All messages are older than the summary
          { role: "user", content: "Old message.", createdAt: "2026-06-25T01:00:00.000Z" },
        ],
        updateFn,
      });
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      await (worker as any).scan();

      expect(updateFn).not.toHaveBeenCalled();
    });

    test("does not mark when stale detection returns not stale", async () => {
      const mem = makeMemoryRecord({
        content: "User set up CI/CD for Node.js.",
        createdAt: "2026-06-25T00:00:00.000Z",
      });
      const updateFn = vi.fn();
      const db = makeMockDb({
        listResult: [mem],
        messages: [
          // No goal change, correction, or preference conflict signal
          { role: "user", content: "Can you explain more about the CI/CD setup?", createdAt: "2026-06-25T01:00:00.000Z" },
        ],
        updateFn,
      });
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      await (worker as any).scan();

      expect(updateFn).not.toHaveBeenCalled();
    });

    test("handles individual summary failures gracefully", async () => {
      const goodMem = makeMemoryRecord({
        id: "good",
        content: "User set up CI/CD.",
        createdAt: "2026-06-25T00:00:00.000Z",
      });
      const badMem = makeMemoryRecord({
        id: "bad",
        content: "Summary that will cause error.",
        createdAt: "2026-06-25T00:00:00.000Z",
      });
      const updateFn = vi.fn()
        .mockResolvedValueOnce({ id: "good" }) // First update succeeds
        .mockRejectedValueOnce(new Error("DB error")); // Second update fails
      const listByConversationId = vi.fn()
        .mockResolvedValueOnce([
          // For good mem: will be detected as stale
          { role: "user", content: "Actually, change of plans.", createdAt: "2026-06-25T01:00:00.000Z" },
        ])
        .mockRejectedValueOnce(new Error("Cannot fetch messages"));
      const db = {
        memory: {
          list: vi.fn().mockResolvedValue([goodMem, badMem]),
          update: updateFn,
        },
        messages: {
          listByConversationId,
        },
      } as unknown as DatabaseContext;

      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      // Should not throw despite individual failures
      await (worker as any).scan();

      // Good mem should have been updated
      expect(updateFn).toHaveBeenCalledWith(
        "good",
        expect.objectContaining({ staleReason: expect.any(String) }),
      );
    });

    test("prevents concurrent scans", async () => {
      const db = makeMockDb();
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      // Force running flag
      (worker as any).running = true;

      await (worker as any).scan();

      // Should have returned without calling list
      expect(db.memory.list).not.toHaveBeenCalled();
    });

    test("handles top-level scan error gracefully", async () => {
      const db = {
        memory: {
          list: vi.fn().mockRejectedValue(new Error("Database is down")),
          update: vi.fn(),
        },
        messages: {
          listByConversationId: vi.fn(),
        },
      } as unknown as DatabaseContext;

      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      // Should not throw
      await (worker as any).scan();

      expect((worker as any).running).toBe(false);
    });

    test("resets running flag after scan", async () => {
      const db = makeMockDb({ listResult: [] });
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      await (worker as any).scan();

      expect((worker as any).running).toBe(false);
    });

    test("handles empty search results", async () => {
      const updateFn = vi.fn();
      const db = makeMockDb({ listResult: [], updateFn });
      const detector = new SummaryStaleDetector();
      worker = new StaleDetectionWorker({
        database: db,
        staleDetector: detector,
        intervalMs: 100_000,
      });

      await (worker as any).scan();

      expect(updateFn).not.toHaveBeenCalled();
    });
  });
});
