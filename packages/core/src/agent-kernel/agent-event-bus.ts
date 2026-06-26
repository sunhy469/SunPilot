import type { AgentEventType } from '@sunpilot/protocol';

/**
 * AgentEventBus — 进程内类型化事件发射器。
 *
 * 事件流向：
 *   业务逻辑 → EventBus.emit()
 *     → 持久化订阅者（RepositoryAgentEventSink → DB events 表）
 *     → WebSocket 订阅者（daemon event-streamer → 前端推送）
 *
 * 事件总线本身与传输协议解耦。所有持久化和 WebSocket 转发由外部订阅者完成。
 *
 * 订阅者调用规则：
 * - 同步订阅者：按注册顺序同步调用，异常被捕获并记录
 * - 异步订阅者：fire-and-forget，不阻塞 emit/publish 返回
 * - 调用方如需等待异步订阅者完成（例如在退订 liveEventBus 前
 *   确保 persist bridge 已将所有待处理事件发布到 liveEventBus），
 *   可调用 flush() 等待所有 pending 异步监听器 settle。
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

  /**
   * Wait for all currently pending async listeners to settle.
   * After resolution, all events published before the flush() call
   * have been processed by async subscribers (e.g. the persist bridge
   * has published them to liveEventBus).
   *
   * New events published concurrently with flush() may or may not be
   * covered — callers that need deterministic coverage should pause
   * event emission before calling flush().
   */
  flush(): Promise<void>;

  /** Number of active subscribers. */
  readonly subscriberCount: number;
}

export class InMemoryAgentEventBus implements AgentEventBus {
  private listeners: AgentEventListener[] = [];
  private pending: Set<Promise<void>> = new Set();

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
        // Track pending promises so flush() can wait for them.
        if (result instanceof Promise) {
          const tracked = result
            .catch((err) => {
              console.error('[AgentEventBus] async listener error:', err);
            })
            .finally(() => {
              this.pending.delete(tracked);
            });
          this.pending.add(tracked);
        }
      } catch (err) {
        console.error('[AgentEventBus] sync listener error:', err);
      }
    }
  }

  async flush(): Promise<void> {
    // Drain all pending async listeners.  New listeners may be enqueued
    // while we drain, so loop until the set is truly empty.
    // §B20: cap iterations to prevent an infinite loop when a listener
    // synchronously re-emits events on each resolve.
    const MAX_FLUSH_ITERATIONS = 50;
    let iteration = 0;
    while (this.pending.size > 0) {
      if (iteration >= MAX_FLUSH_ITERATIONS) {
        console.warn(
          `[AgentEventBus] flush exceeded ${MAX_FLUSH_ITERATIONS} iterations with ${this.pending.size} pending tasks; breaking to avoid infinite loop`,
        );
        break;
      }
      iteration++;
      const snapshot = Array.from(this.pending);
      await Promise.all(snapshot);
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

/**
 * §6.5: Throttled delta emitter — batches `agent.model.delta` events
 * so at most one is emitted per `intervalMs` (default 50ms). This
 * prevents WebSocket broadcast flooding when the LLM streams many small
 * chunks in rapid succession.
 *
 * The accumulated delta is emitted as a single batched event. Call
 * `flush()` when streaming completes to emit any remaining buffered text.
 */
export class DeltaThrottle {
  private buffer = "";
  private lastEmit = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly emit: (delta: string) => void,
    private readonly intervalMs: number = 50,
  ) {}

  /** Add a delta chunk. Emits a batched event if the interval has elapsed. */
  push(delta: string): void {
    this.buffer += delta;
    const now = Date.now();
    if (now - this.lastEmit >= this.intervalMs) {
      this.flush();
    } else if (!this.timer) {
      // Schedule a flush to ensure buffered deltas aren't held too long
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (this.buffer) this.flush();
      }, this.intervalMs);
    }
  }

  /** Emit any buffered delta immediately. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buffer) {
      this.lastEmit = Date.now();
      this.emit(this.buffer);
      this.buffer = "";
    }
  }
}
