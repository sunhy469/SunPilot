import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { InMemoryAgentEventBus, type AgentEvent } from "@sunpilot/core";

import { createPersistenceLayer } from "./persistence-factory.js";

function makeEvent(partial: Partial<AgentEvent> & { type: AgentEvent["type"] }): AgentEvent {
  return {
    id: `evt_${Math.random().toString(36).slice(2)}`,
    runId: "run_test",
    sequence: undefined,
    timestamp: new Date().toISOString(),
    type: partial.type,
    payload: partial.payload ?? {},
    ...partial,
  } as AgentEvent;
}

describe("createPersistenceLayer", () => {
  test("wires rawEventBus → persist → liveEventBus", async () => {
    const db = new InMemoryDatabaseContext();
    const { rawEventBus, liveEventBus } = createPersistenceLayer({ database: db });

    const seen: AgentEvent[] = [];
    liveEventBus.subscribe(async (event) => {
      seen.push(event);
    });

    const event = makeEvent({ type: "agent.run.created" });
    rawEventBus.publish(event);

    // Wait for async persist + forward
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen.length).toBe(1);
    // Persisted events gain a DB sequence number
    expect(seen[0]?.sequence).not.toBeUndefined();
  });

  test("forwards already-persisted events directly without re-persisting", async () => {
    const db = new InMemoryDatabaseContext();
    const { rawEventBus, liveEventBus } = createPersistenceLayer({ database: db });

    const seen: AgentEvent[] = [];
    liveEventBus.subscribe(async (event) => {
      seen.push(event);
    });

    const event = makeEvent({
      type: "agent.run.created",
      sequence: 42, // Already persisted upstream
    });
    rawEventBus.publish(event);

    await new Promise((resolve) => setImmediate(resolve));

    expect(seen.length).toBe(1);
    expect(seen[0]?.sequence).toBe(42);
  });

  test("skips persistence for agent.message.part.delta (transient streaming)", async () => {
    const db = new InMemoryDatabaseContext();
    const { rawEventBus, liveEventBus } = createPersistenceLayer({ database: db });

    const seen: AgentEvent[] = [];
    liveEventBus.subscribe(async (event) => {
      seen.push(event);
    });

    rawEventBus.publish(
      makeEvent({ type: "agent.message.part.delta", payload: { delta: "tok" } }),
    );

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(seen.length).toBe(0);
  });

  test("returns AbortRegistry, RunStateManager, EventSink, and RunInitializer bound to the same DB", () => {
    const db = new InMemoryDatabaseContext();
    const { abortRegistry, runStateManager, eventSink, agentRunInitializer } =
      createPersistenceLayer({ database: db });

    expect(abortRegistry).toBeDefined();
    expect(runStateManager).toBeDefined();
    expect(eventSink).toBeDefined();
    expect(agentRunInitializer).toBeDefined();
  });

  test("reuses injected eventBus when provided", () => {
    const db = new InMemoryDatabaseContext();
    const injectedRaw = new InMemoryAgentEventBus();
    const injectedLive = new InMemoryAgentEventBus();
    const { rawEventBus, liveEventBus } = createPersistenceLayer({
      database: db,
      eventBus: injectedRaw,
      liveEventBus: injectedLive,
    });

    expect(rawEventBus).toBe(injectedRaw);
    expect(liveEventBus).toBe(injectedLive);
  });
});
