import { describe, expect, test, vi } from "vitest";
import { InMemoryAgentEventBus, DeltaThrottle } from "./agent-event-bus.js";
import type { AgentEvent } from "./agent-event-bus.js";

// ── AgentEventBus ────────────────────────────────────────────────────

describe("InMemoryAgentEventBus", () => {
  test("emit calls all subscribed listeners", () => {
    const bus = new InMemoryAgentEventBus();
    const events1: AgentEvent[] = [];
    const events2: AgentEvent[] = [];

    bus.subscribe((e) => events1.push(e));
    bus.subscribe((e) => events2.push(e));

    bus.emit("agent.run.started" as any, { foo: "bar" });

    expect(events1).toHaveLength(1);
    expect(events1[0]!.type).toBe("agent.run.started");
    expect(events1[0]!.payload).toEqual({ foo: "bar" });

    expect(events2).toHaveLength(1);
    expect(events2[0]!.type).toBe("agent.run.started");
  });

  test("emit creates event with required fields", () => {
    const bus = new InMemoryAgentEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe((e) => captured.push(e));

    bus.emit("test.type" as any, { key: "value" });

    expect(captured[0]!.id).toMatch(/^evt_/);
    expect(captured[0]!.type).toBe("test.type");
    expect(captured[0]!.payload).toEqual({ key: "value" });
    expect(captured[0]!.createdAt).toBeDefined();
    expect(new Date(captured[0]!.createdAt).getTime()).not.toBeNaN();
  });

  test("emit sets runId and conversationId from meta", () => {
    const bus = new InMemoryAgentEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe((e) => captured.push(e));

    bus.emit("test.type" as any, {}, { runId: "run_1", conversationId: "conv_1" });

    expect(captured[0]!.runId).toBe("run_1");
    expect(captured[0]!.conversationId).toBe("conv_1");
  });

  test("emit without meta leaves runId and conversationId undefined", () => {
    const bus = new InMemoryAgentEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe((e) => captured.push(e));

    bus.emit("test.type" as any, {});

    expect(captured[0]!.runId).toBeUndefined();
    expect(captured[0]!.conversationId).toBeUndefined();
  });

  test("subscribe returns unsubscribe function", () => {
    const bus = new InMemoryAgentEventBus();
    const captured: AgentEvent[] = [];
    const unsubscribe = bus.subscribe((e) => captured.push(e));

    bus.emit("first" as any, {});
    expect(captured).toHaveLength(1);

    unsubscribe();
    bus.emit("second" as any, {});
    expect(captured).toHaveLength(1); // no new event received
  });

  test("publish preserves event id and sequence", () => {
    const bus = new InMemoryAgentEventBus();
    const captured: AgentEvent[] = [];
    bus.subscribe((e) => captured.push(e));

    bus.publish({
      id: "custom_event_id",
      type: "custom.type" as any,
      sequence: 42,
      payload: { data: "test" },
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    expect(captured[0]!.id).toBe("custom_event_id");
    expect(captured[0]!.sequence).toBe(42);
  });

  test("sync listener error does not affect other listeners", () => {
    const bus = new InMemoryAgentEventBus();
    const captured: AgentEvent[] = [];

    // Listener that throws
    bus.subscribe(() => {
      throw new Error("sync listener error");
    });
    // Listener that should still receive events
    bus.subscribe((e) => captured.push(e));

    // Should not throw
    bus.emit("test.type" as any, {});
    expect(captured).toHaveLength(1);
  });

  test("async listener is fire-and-forget (emit returns before completion)", async () => {
    const bus = new InMemoryAgentEventBus();
    let resolved = false;

    bus.subscribe(async () => {
      await new Promise((r) => setTimeout(r, 50));
      resolved = true;
    });

    bus.emit("test.type" as any, {});
    // emit returns immediately, async listener hasn't completed yet
    expect(resolved).toBe(false);

    // Wait for async listener
    await bus.flush();
    expect(resolved).toBe(true);
  });

  test("async listener error is caught and logged (does not propagate)", async () => {
    const bus = new InMemoryAgentEventBus();

    bus.subscribe(async () => {
      throw new Error("async listener error");
    });

    // Should not throw
    bus.emit("test.type" as any, {});
    // Should not throw on flush
    await bus.flush();
  });

  test("flush waits for all pending async listeners", async () => {
    const bus = new InMemoryAgentEventBus();
    const completed: string[] = [];

    bus.subscribe(async () => {
      await new Promise((r) => setTimeout(r, 30));
      completed.push("first");
    });
    bus.subscribe(async () => {
      await new Promise((r) => setTimeout(r, 20));
      completed.push("second");
    });

    bus.emit("test.type" as any, {});
    await bus.flush();

    expect(completed).toContain("first");
    expect(completed).toContain("second");
  });

  test("flush with no pending listeners resolves immediately", async () => {
    const bus = new InMemoryAgentEventBus();
    const start = Date.now();
    await bus.flush();
    // Should resolve in well under 50ms
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("subscriberCount returns correct count", () => {
    const bus = new InMemoryAgentEventBus();
    expect(bus.subscriberCount).toBe(0);

    const unsub1 = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(1);

    const unsub2 = bus.subscribe(() => {});
    expect(bus.subscriberCount).toBe(2);

    unsub1();
    expect(bus.subscriberCount).toBe(1);

    unsub2();
    expect(bus.subscriberCount).toBe(0);
  });

  test("listeners are called in registration order", () => {
    const bus = new InMemoryAgentEventBus();
    const order: number[] = [];

    bus.subscribe(() => order.push(1));
    bus.subscribe(() => order.push(2));
    bus.subscribe(() => order.push(3));

    bus.emit("test" as any, {});
    expect(order).toEqual([1, 2, 3]);
  });
});

// ── DeltaThrottle ────────────────────────────────────────────────────

describe("DeltaThrottle", () => {
  test("push accumulates deltas and emits batched on flush", () => {
    const emitted: string[] = [];
    const throttle = new DeltaThrottle((delta) => emitted.push(delta), 50);

    // First push always emits immediately (lastEmit starts at 0)
    throttle.push("first batch: ");
    expect(emitted).toHaveLength(1);

    // Subsequent rapid pushes within the interval accumulate
    throttle.push("hello ");
    throttle.push("world");

    throttle.flush();
    expect(emitted[1]).toBe("hello world");
  });

  test("flush with empty buffer is a no-op", () => {
    const emitted: string[] = [];
    const throttle = new DeltaThrottle((delta) => emitted.push(delta), 50);

    throttle.flush();
    expect(emitted).toHaveLength(0);
  });

  test("rapid pushes within the interval batch into single emit on flush", () => {
    const emitted: string[] = [];

    // Trigger first emit to set lastEmit
    const throttle = new DeltaThrottle((delta) => emitted.push(delta), 50);
    throttle.push("first");
    throttle.flush();
    emitted.length = 0; // reset

    // Now within the same interval, multiple pushes accumulate
    throttle.push("a");
    throttle.push("b");
    throttle.push("c");

    // Not yet emitted (within interval from lastEmit)
    expect(emitted).toHaveLength(0);

    throttle.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe("abc");
  });

  test("timer-based flush fires after interval", async () => {
    vi.useFakeTimers();
    const emitted: string[] = [];

    // Build with a known lastEmit by doing an initial push+flush
    const throttle = new DeltaThrottle((delta) => emitted.push(delta), 100);
    throttle.push("warmup");
    throttle.flush();
    emitted.length = 0;

    // Now push — should schedule a timer since lastEmit is recent
    throttle.push("hello");
    expect(emitted).toHaveLength(0);

    // Advance past the interval
    vi.advanceTimersByTime(110);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe("hello");

    vi.useRealTimers();
  });

  test("calling flush cancels the scheduled timer", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const throttle = new DeltaThrottle((delta) => emitted.push(delta), 50);

    // Warmup to set lastEmit to current fake time
    throttle.push("warmup");
    throttle.flush();
    emitted.length = 0;

    throttle.push("hello");
    throttle.flush();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toBe("hello");

    // Advance past the interval — nothing more should be emitted
    vi.advanceTimersByTime(100);
    expect(emitted).toHaveLength(1);

    vi.useRealTimers();
  });

  test("consecutive push+flush cycles emit separately", () => {
    const emitted: string[] = [];
    const throttle = new DeltaThrottle((delta) => emitted.push(delta), 50);

    throttle.push("first");
    throttle.flush();
    expect(emitted).toContain("first");

    throttle.push("second");
    throttle.flush();
    expect(emitted).toContain("second");
  });

  test("does not emit duplicate on flush after timer has already fired", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const throttle = new DeltaThrottle((delta) => emitted.push(delta), 50);

    // Warmup
    throttle.push("warmup");
    throttle.flush();
    emitted.length = 0;

    throttle.push("hello");

    // Timer fires
    vi.advanceTimersByTime(60);
    expect(emitted).toHaveLength(1);

    // Flush after timer already emitted — no-op
    throttle.flush();
    expect(emitted).toHaveLength(1);

    vi.useRealTimers();
  });

  test("custom interval is respected", () => {
    vi.useFakeTimers();
    const emitted: string[] = [];
    const throttle = new DeltaThrottle((delta) => emitted.push(delta), 100);

    // Warmup
    throttle.push("warmup");
    throttle.flush();
    emitted.length = 0;

    throttle.push("hello");

    // At 50ms, timer hasn't fired yet
    vi.advanceTimersByTime(50);
    expect(emitted).toHaveLength(0);

    // At 110ms, timer has fired
    vi.advanceTimersByTime(60);
    expect(emitted).toHaveLength(1);

    vi.useRealTimers();
  });
});
