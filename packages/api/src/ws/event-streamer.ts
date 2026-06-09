import type { AgentEvent } from "@sunpilot/core";
import type {
  ConnectionRegistry,
  WebSocketLike,
} from "./connection-registry.js";
import { websocketNotificationForEvent } from "./ws-protocol.js";

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
      deps.send(socket, notification);
    }
  });
}
