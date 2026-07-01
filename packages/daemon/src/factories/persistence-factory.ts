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
  type AgentEvent,
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
  /** Stop background timers (flush outbox). Safe to call multiple times. */
  stop(): void;
  /** Number of events that exhausted all retry attempts and sit in the outbox. */
  getPersistFailureCount(): number;
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
  // events for that message. Lifecycle starts are also persisted in the same
  // serialized queue for reconnect replay; high-volume deltas stay transient.
  const SYNC_FORWARD_TYPES = new Set([
    "agent.message.started",
    "agent.message.part.started",
    "agent.message.part.delta",
  ]);

  // §P2-06: Persist every replayable event to a PostgreSQL outbox before
  // delivery. Delivery is idempotent by event id, so a daemon crash between
  // append and outbox deletion is safely replayed on the next startup.
  const MAX_PERSIST_ATTEMPTS = 3;
  const FLUSH_INTERVAL_MS = 60_000;
  const failedEvents: AgentEvent[] = [];
  let persistFailures = 0;
  let persistenceQueue = Promise.resolve();

  const enqueuePersistenceTask = (work: () => Promise<void>): Promise<void> => {
    const task = persistenceQueue.then(work);
    persistenceQueue = task.catch(() => undefined);
    return task;
  };

  const persistWithRetry = async (
    event: Parameters<AgentEventBus["publish"]>[0],
    forward: boolean,
  ): Promise<void> => {
    if (!event.runId) return;
    for (let attempt = 1; attempt <= MAX_PERSIST_ATTEMPTS; attempt++) {
      try {
        await deps.database.events.enqueueOutbox?.(
          event as import("@sunpilot/protocol").SunPilotEvent,
        );
        const persisted = await eventSink.persist(event);
        await deps.database.events.deleteOutbox?.(event.id);
        if (forward && persisted) liveEventBus.publish(persisted);
        return;
      } catch (err) {
        if (attempt === MAX_PERSIST_ATTEMPTS) {
          persistFailures++;
          failedEvents.push(event);
          console.error(
            `[eventBus] Failed to persist event after ${MAX_PERSIST_ATTEMPTS} attempts:`,
            (err as Error).message,
            { eventType: event.type, eventId: event.id },
          );
          return;
        }
        await new Promise((r) => setTimeout(r, 100 * attempt * attempt));
      }
    }
  };

  const flushFailedEvents = async (): Promise<void> => {
    const durableBatch =
      (await deps.database.events.listOutbox?.(200).catch(() => [])) ?? [];
    const byId = new Map<string, AgentEvent>();
    for (const event of [...durableBatch, ...failedEvents.splice(0)]) {
      byId.set(event.id, event as AgentEvent);
    }
    const batch = [...byId.values()];
    if (batch.length === 0) return;
    for (let index = 0; index < batch.length; index++) {
      const event = batch[index]!;
      try {
        const persisted = await eventSink.persist(event);
        await deps.database.events.deleteOutbox?.(event.id);
        if (persisted) liveEventBus.publish(persisted);
      } catch (err) {
        // Re-queue the failed event and every not-yet-processed in-memory
        // event. Durable rows remain in PostgreSQL, and Map de-duplication on
        // the next pass prevents double delivery.
        failedEvents.push(...batch.slice(index));
        console.warn(
          `[eventBus] Flush retry failed for event ${event.id}:`,
          (err as Error).message,
        );
        return;
      }
    }
  };

  const scheduleOutboxFlush = (): Promise<void> =>
    enqueuePersistenceTask(flushFailedEvents);

  const flushTimer = setInterval(() => {
    void scheduleOutboxFlush();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref();
  // Queue startup recovery before accepting newly emitted events so recovered
  // events cannot race or overtake the live persistence stream.
  void scheduleOutboxFlush();

  const persistInOrder = (
    event: Parameters<AgentEventBus["publish"]>[0],
    forward: boolean,
  ): Promise<void> => {
    return enqueuePersistenceTask(() => persistWithRetry(event, forward));
  };

  rawEventBus.subscribe((event) => {
    if (event.sequence !== undefined) {
      // Already persisted (e.g. atomically created with DB sequence) —
      // forward directly to liveEventBus without re-persisting.
      liveEventBus.publish(event);
      return;
    }
    if (SYNC_FORWARD_TYPES.has(event.type)) {
      liveEventBus.publish(event);
      // Deltas are intentionally transient. Lifecycle starts are persisted for
      // replay, but are not forwarded a second time after persistence.
      if (event.type === "agent.message.part.delta") return;
      return persistInOrder(event, false).catch((err) => {
        console.error("[eventBus] Failed to persist event:", (err as Error).message);
      });
    }
    return persistInOrder(event, true).catch((err) => {
      console.error("[eventBus] Failed to persist event:", (err as Error).message);
    });
  });

  return {
    rawEventBus,
    liveEventBus,
    abortRegistry,
    runStateManager,
    eventSink,
    agentRunInitializer,
    stop: () => {
      clearInterval(flushTimer);
    },
    getPersistFailureCount: () => persistFailures,
  };
}
