import type { AgentEventType } from '@sunpilot/protocol';

/**
 * AgentEventBus — in-process typed event emitter.
 *
 * Events flow: business logic → EventBus.emit()
 *   → memory subscribers (logging, metrics)
 *   → database sink (persistence)
 *   → WebSocket sink (frontend push)
 *
 * The actual persistence and WebSocket forwarding are done by
 * subscribing listeners; the EventBus itself is transport-agnostic.
 */

export interface AgentEvent<P = Record<string, unknown>> {
  id: string;
  type: AgentEventType;
  runId?: string;
  conversationId?: string;
  sequence?: number;
  payload: P;
  createdAt: string;
}

export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export interface AgentEventBus {
  /** Emit a typed event. Returns after all synchronous subscribers run. */
  emit<T extends Record<string, unknown>>(
    type: AgentEventType,
    payload: T,
    meta?: { runId?: string; conversationId?: string },
  ): void;

  /** Publish an already-created event, preserving id and sequence. */
  publish(event: AgentEvent): void;

  /**
   * Subscribe to all events. Returns an unsubscribe function.
   * Subscribers are called synchronously in registration order.
   * Async subscribers are fire-and-forget (not awaited).
   */
  subscribe(listener: AgentEventListener): () => void;

  /** Number of active subscribers. */
  readonly subscriberCount: number;
}

export class InMemoryAgentEventBus implements AgentEventBus {
  private listeners: AgentEventListener[] = [];

  emit<T extends Record<string, unknown>>(
    type: AgentEventType,
    payload: T,
    meta?: { runId?: string; conversationId?: string },
  ): void {
    const event: AgentEvent<T> = {
      id: `evt_${crypto.randomUUID()}`,
      type,
      runId: meta?.runId,
      conversationId: meta?.conversationId,
      payload,
      createdAt: new Date().toISOString(),
    };

    this.publish(event as AgentEvent);
  }

  publish(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        // Fire-and-forget async listeners; errors are logged but not thrown.
        if (result instanceof Promise) {
          result.catch((err) => {
            console.error('[AgentEventBus] async listener error:', err);
          });
        }
      } catch (err) {
        console.error('[AgentEventBus] sync listener error:', err);
      }
    }
  }

  subscribe(listener: AgentEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  get subscriberCount(): number {
    return this.listeners.length;
  }
}
