import type { SunPilotEvent } from "@sunpilot/protocol";
import type {
  ConnectionRegistry,
  WebSocketLike,
} from "./connection-registry.js";
import { websocketNotificationForEvent } from "./ws-protocol.js";

export interface RuntimeEventSource {
  subscribeEvents(listener: (event: SunPilotEvent) => void): () => void;
}

/**
 * 订阅 Runtime 事件 → 通过 WebSocket 推送到前端。
 *
 * 事件推送链：
 * Agent Loop 内部 emit/publish → AgentEventBus → RepositoryAgentEventSink（持久化）
 *   → RuntimeStore.subscribeEvents → event-streamer → ConnectionRegistry.interestedSockets
 *   → WebSocket send（JSON-RPC notification 格式）
 *
 * 返回取消订阅函数，daemon stop 时调用。
 */
export function subscribeEventStreamer<TSocket extends WebSocketLike>(deps: {
  runtimeStore: RuntimeEventSource;
  registry: ConnectionRegistry<TSocket>;
  send(socket: TSocket, notification: unknown): void;
}): () => void {
  return deps.runtimeStore.subscribeEvents((event) => {
    const notification = websocketNotificationForEvent(event);
    for (const socket of deps.registry.interestedSockets(event)) {
      deps.send(socket, notification);
    }
  });
}
