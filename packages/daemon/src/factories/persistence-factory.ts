/**
 * Persistence factory — wires the Foundation layer: event bus bridge, abort
 * registry, run state manager, event sink, and run initializer.
 *
 * Extracted from composition-root.ts (Batch 4 §3): split into model/context/
 * tool/safety/persistence factories with wiring tests.
 */
import type { DatabaseContext } from "@sunpilot/storage";
import {
  AbortRegistry,
  InMemoryAgentEventBus,
  RepositoryAgentEventSink,
  RepositoryAgentRunInitializer,
  RepositoryRunStateManager,
  type AgentEventBus,
} from "@sunpilot/core";

export interface PersistenceFactoryDeps {
  database: DatabaseContext;
  eventBus?: AgentEventBus;
  liveEventBus?: AgentEventBus;
}

export interface PersistenceFactoryResult {
  rawEventBus: AgentEventBus;
  liveEventBus: AgentEventBus;
  abortRegistry: AbortRegistry;
  runStateManager: RepositoryRunStateManager;
  eventSink: RepositoryAgentEventSink;
  agentRunInitializer: RepositoryAgentRunInitializer;
}

export function createPersistenceLayer(
  deps: PersistenceFactoryDeps,
): PersistenceFactoryResult {
  const rawEventBus = deps.eventBus ?? new InMemoryAgentEventBus();
  const liveEventBus = deps.liveEventBus ?? new InMemoryAgentEventBus();
  const abortRegistry = new AbortRegistry();
  const runStateManager = new RepositoryRunStateManager(deps.database);
  const eventSink = new RepositoryAgentEventSink(deps.database);
  const agentRunInitializer = new RepositoryAgentRunInitializer(deps.database);

  // Wire: rawEventBus → persist → liveEventBus.
  // Internal components emit to rawEventBus; the persist subscriber bridges
  // persisted events to liveEventBus, which WebSocket broadcasters and
  // external stream hooks consume. This ensures all externally visible
  // events carry a real DB sequence (no sequence: -1 duplicates).
  //
  // Lifecycle events (message.started, part.started) and streaming deltas
  // (part.delta) are forwarded synchronously to liveEventBus to guarantee
  // ordering — the frontend must receive message.started before any part
  // events for that message. These are NOT persisted (transient).
  const SYNC_FORWARD_TYPES = new Set([
    "agent.message.started",
    "agent.message.part.started",
    "agent.message.part.delta",
  ]);

  rawEventBus.subscribe(async (event) => {
    if (event.sequence !== undefined) {
      // Already persisted (e.g. atomically created with DB sequence) —
      // forward directly to liveEventBus without re-persisting.
      liveEventBus.publish(event);
      return;
    }
    if (SYNC_FORWARD_TYPES.has(event.type)) {
      liveEventBus.publish(event);
      return;
    }
    try {
      const persisted = await eventSink.persist(event);
      if (persisted) liveEventBus.publish(persisted);
    } catch (err) {
      console.error("[eventBus] Failed to persist event:", (err as Error).message);
    }
  });

  return {
    rawEventBus,
    liveEventBus,
    abortRegistry,
    runStateManager,
    eventSink,
    agentRunInitializer,
  };
}
