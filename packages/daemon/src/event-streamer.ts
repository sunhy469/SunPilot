import type { SunPilotEvent } from "@sunpilot/protocol";
import type {
  ConnectionRegistry,
  WebSocketLike,
} from "./connection-registry.js";
import { websocketNotificationForEvent } from "./ws-protocol.js";

export interface RuntimeEventSource {
  subscribeEvents(listener: (event: SunPilotEvent) => void): () => void;
}

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
