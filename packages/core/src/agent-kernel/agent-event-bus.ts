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
