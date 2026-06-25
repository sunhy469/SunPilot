import type { AgentEvent } from "@sunpilot/core";
import type {
  ConnectionRegistry,
  WebSocketLike,
} from "./connection-registry.js";
import { websocketNotificationForEvent } from "./ws-protocol.js";

/** Per-socket backpressure threshold (1 MiB). When a slow client's queued
 * output exceeds this, the streamer drops further notifications for it to
 * avoid unbounded memory growth (A13). */
const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;

/**
 * 订阅 Agent 事件 → 通过 WebSocket 推送到前端。
 */
export function subscribeEventStreamer<TSocket extends WebSocketLike>(deps: {
  subscribe(listener: (event: AgentEvent) => void): () => void;
  registry: ConnectionRegistry<TSocket>;
  send(socket: TSocket, notification: unknown): void;
}): () => void {
  return deps.subscribe((event) => {
    const notification = websocketNotificationForEvent(event);
    for (const socket of deps.registry.interestedSockets(event)) {
      // A13: Backpressure guard. If the client is slow and the OS buffer
      // has grown past the limit, skip this notification rather than
      // queuing more data that could exhaust server memory.
      if (
        typeof socket.bufferedAmount === "number" &&
        socket.bufferedAmount >= BACKPRESSURE_LIMIT_BYTES
      ) {
        console.warn(
          `[event-streamer] Dropping notification for slow client ` +
            `(bufferedAmount=${socket.bufferedAmount} bytes).`,
        );
        continue;
      }
      deps.send(socket, notification);
    }
  });
}
