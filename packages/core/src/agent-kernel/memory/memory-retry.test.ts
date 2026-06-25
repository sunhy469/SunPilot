import { describe, expect, test, vi, beforeEach } from "vitest";
import { MemoryRetryWrapper } from "./memory-retry.js";
import type { MemoryWriteInput, MemoryWriteResult } from "./memory-types.js";

function makeMockWriter(
  behavior: "success" | "fail_then_succeed" | "always_fail" = "success",
) {
  const calls: MemoryWriteInput[] = [];
  const writeFromTurn = vi.fn(async (input: MemoryWriteInput): Promise<MemoryWriteResult> => {
    calls.push(input);
    if (behavior === "always_fail") {
      throw new Error("Database connection lost");
    }
    if (behavior === "fail_then_succeed" && calls.length === 1) {
      throw new Error("Temporary write failure");
    }
    return {
      written: [
        {
          id: `memory_${calls.length}`,
          key: "test_key",
          value: "test_value",
          scope: "user",
          scopeId: "u1",
          type: "user_preference",
          title: "Test",
          content: "Test content",
          source: "user_explicit",
          confidence: 0.9,
          importance: 0.6,
          metadata: {},
          createdAt: new Date().toISOString(),
        },
      ],
      rejected: [],
      superseded: [],
    };
  });

  return { writeFromTurn, calls };
}

function makeMockEventBus() {
  const events: Array<[string, unknown]> = [];
  return {
    events,
    emit: vi.fn((event: string, payload: unknown) => {
      events.push([event, payload]);
    }),
  };
}

describe("MemoryRetryWrapper", () => {
  let clock: { current: number };

  beforeEach(() => {
    clock = { current: 0 };
  });

  function fastClock(): () => Date {
    // Advance clock by 1 second each call (for setTimeout simulation)
    return () => new Date(clock.current);
  }

  function makeInput(): MemoryWriteInput {
    return {
      input: {
        runId: "run_1",
        conversationId: "conv_1",
        userMessageId: "msg_1",
        userId: "user_1",
        message: "test",
        mode: "chat",
        client: { source: "web" },
      },
      context: {
        runId: "run_1",
        conversationId: "conv_1",
        userId: "user_1",
        system: { persona: "test", rules: [], safety: [] },
        currentMessage: { id: "msg_1", content: "test", attachments: [] },
        messages: [],
        memories: [],
        artifacts: [],
        toolResults: [],
        availableSkills: [],
        limits: { maxTokens: 1000, reservedForOutput: 100, usedTokensEstimate: 10 },
        tokenEstimate: 10,
      },
      intent: {
        type: "casual_chat",
        confidence: 0.8,
        requiresPlanning: false,
        requiresTool: false,
        requiresApproval: false,
        riskLevel: "low",
        candidateSkills: [],
        reason: "test",
      },
    };
  }

  test("succeeds on first attempt", async () => {
    const mockWriter = makeMockWriter("success");
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      { writeFromTurn: mockWriter.writeFromTurn },
      eventBus as any,
      { clock: fastClock() },
    );
    const input = makeInput();

    const result = await wrapper.writeFromTurn(input);

    expect(result.written).toHaveLength(1);
    expect(mockWriter.writeFromTurn).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  test("retries and succeeds after one failure", async () => {
    const mockWriter = makeMockWriter("fail_then_succeed");
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      { writeFromTurn: mockWriter.writeFromTurn },
      eventBus as any,
      { maxRetries: 2, baseDelayMs: 10, clock: fastClock() },
    );
    const input = makeInput();

    const result = await wrapper.writeFromTurn(input);

    expect(result.written).toHaveLength(1);
    expect(mockWriter.writeFromTurn).toHaveBeenCalledTimes(2);
    expect(eventBus.emit).not.toHaveBeenCalled(); // Event only on total failure
  });

  test("returns empty result after all retries exhausted", async () => {
    const mockWriter = makeMockWriter("always_fail");
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      { writeFromTurn: mockWriter.writeFromTurn },
      eventBus as any,
      { maxRetries: 1, baseDelayMs: 10, clock: fastClock() },
    );
    const input = makeInput();

    const result = await wrapper.writeFromTurn(input);

    expect(result.written).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(result.superseded).toHaveLength(0);
    expect(mockWriter.writeFromTurn).toHaveBeenCalledTimes(2); // 1 original + 1 retry = 2
  });

  test("emits failure event when all retries exhausted", async () => {
    const mockWriter = makeMockWriter("always_fail");
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      { writeFromTurn: mockWriter.writeFromTurn },
      eventBus as any,
      { maxRetries: 0, baseDelayMs: 10, clock: fastClock() },
    );
    const input = makeInput();

    await wrapper.writeFromTurn(input);

    expect(eventBus.emit).toHaveBeenCalled();
    const [eventName] = eventBus.events[0]!;
    expect(eventName).toBe("agent.memory.write_failed");
    // Event payload should contain error info
    const payload = eventBus.events[0]![1] as any;
    expect(payload.code).toBe("AGENT_MEMORY_WRITE_FAILED");
    expect(payload.category).toBe("memory");
    expect(payload.retryable).toBe(false);
  });

  test("exponential backoff timing is correct", async () => {
    const mockWriter = makeMockWriter("always_fail");
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      { writeFromTurn: mockWriter.writeFromTurn },
      eventBus as any,
      { maxRetries: 2, baseDelayMs: 100, clock: fastClock() },
    );
    const input = makeInput();

    await wrapper.writeFromTurn(input);

    // 3 attempts total (1 original + 2 retries)
    expect(mockWriter.writeFromTurn).toHaveBeenCalledTimes(3);
    // Base delay 100ms → first retry: 100ms, second retry: 200ms
    // The setTimeout durations are: delay = baseDelayMs * Math.pow(2, attempt)
    // attempt 0: 100 * 2^0 = 100ms
    // attempt 1: 100 * 2^1 = 200ms
  });

  test("uses default config values when not specified", async () => {
    const mockWriter = makeMockWriter("always_fail");
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      { writeFromTurn: mockWriter.writeFromTurn },
      eventBus as any,
    );
    const input = makeInput();

    await wrapper.writeFromTurn(input);

    // Default: maxRetries=2, so 3 total attempts
    expect(mockWriter.writeFromTurn).toHaveBeenCalledTimes(3);
  });

  test("updateMemory delegates to inner writer", async () => {
    const updateMemory = vi.fn().mockResolvedValue({ id: "m1", content: "updated" });
    const mockWriter = {
      writeFromTurn: vi.fn(),
      updateMemory,
    };
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      mockWriter as any,
      eventBus as any,
    );

    const result = await wrapper.updateMemory("m1", { content: "updated" });

    expect(updateMemory).toHaveBeenCalledWith("m1", { content: "updated" });
    expect(result).toEqual({ id: "m1", content: "updated" });
  });

  test("updateMemory returns null when inner writer has no updateMemory", async () => {
    const mockWriter = makeMockWriter("success");
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      { writeFromTurn: mockWriter.writeFromTurn },
      eventBus as any,
    );

    const result = await wrapper.updateMemory("m1", { content: "updated" });

    expect(result).toBeNull();
  });

  test("no retry for updateMemory even on failure", async () => {
    const updateMemory = vi.fn().mockRejectedValue(new Error("Update failed"));
    const mockWriter = {
      writeFromTurn: vi.fn(),
      updateMemory,
    };
    const eventBus = makeMockEventBus();
    const wrapper = new MemoryRetryWrapper(
      mockWriter as any,
      eventBus as any,
    );

    await expect(wrapper.updateMemory("m1", { content: "updated" })).rejects.toThrow("Update failed");
    // Should have been called exactly once (no retries)
    expect(updateMemory).toHaveBeenCalledTimes(1);
  });
});
