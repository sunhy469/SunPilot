import type { Server as HttpServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentService, RepositoryRuntimeStore } from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import { ConnectionRegistry } from "./connection-registry.js";
import { subscribeEventStreamer } from "./event-streamer.js";
import { JsonRpcRouter } from "./json-rpc-router.js";
import { agentErrorNotification, rpcError } from "./ws-protocol.js";

function sendJson(
  socket: WebSocket,
  payload: unknown,
  markActivity?: () => void,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
  markActivity?.();
}

function bindIdleTimeout(socket: WebSocket): () => void {
  const idleTimeoutMs = 60_000;
  let lastActivityAt = Date.now();
  const markActivity = () => {
    lastActivityAt = Date.now();
  };
  const timer = setInterval(() => {
    if (Date.now() - lastActivityAt >= idleTimeoutMs) {
      socket.close(
        4000,
        "Idle timeout: no client or server activity for 60 seconds.",
      );
      clearInterval(timer);
    }
  }, 5_000);
  timer.unref();
  socket.once("close", () => clearInterval(timer));
  socket.once("error", () => clearInterval(timer));
  return markActivity;
}

export function setupDaemonWebSocket(deps: {
  getChatAgent: () => Promise<AgentService>;
  database: DatabaseContext;
  runtimeStore: RepositoryRuntimeStore;
  port: number;
  isAllowedOrigin: (origin: string | undefined, port: number) => boolean;
}) {
  const wsServer = new WebSocketServer({ noServer: true });
  const connectionRegistry = new ConnectionRegistry<WebSocket>(WebSocket.OPEN);
  const jsonRpcRouter = new JsonRpcRouter({
    getChatAgent: deps.getChatAgent,
    database: deps.database,
    runtimeStore: deps.runtimeStore,
  });
  const unsubscribeEvents = subscribeEventStreamer({
    runtimeStore: deps.runtimeStore,
    registry: connectionRegistry,
    send: (socket, notification) => sendJson(socket, notification),
  });

  wsServer.on("connection", (socket, request) => {
    const connection = connectionRegistry.add(socket);
    const markActivity = bindIdleTimeout(socket);
    const notify = (notification: unknown) =>
      sendJson(socket, notification, markActivity);
    socket.once("close", () => {
      connectionRegistry.remove(socket);
    });
    socket.on("message", async (raw) => {
      markActivity();
      let message: { id?: string; method?: string; params?: any } = {};
      try {
        message = JSON.parse(String(raw)) as typeof message;
        const response = await jsonRpcRouter.handle(message, {
          source: "web",
          connectionId: connection.id,
          runSubscriptions: connection.runSubscriptions,
          conversationSubscriptions: connection.conversationSubscriptions,
          notify,
        });
        if (response.error) {
          sendJson(
            socket,
            { jsonrpc: "2.0", id: message.id, error: response.error },
            markActivity,
          );
          return;
        }
        sendJson(
          socket,
          { jsonrpc: "2.0", id: message.id, result: response.result },
          markActivity,
        );
      } catch (error) {
        if (message.method === "chat.send") {
          sendJson(
            socket,
            agentErrorNotification(
              error,
              typeof message.params?.conversationId === "string"
                ? message.params.conversationId
                : undefined,
            ),
            markActivity,
          );
        }
        sendJson(
          socket,
          { jsonrpc: "2.0", id: message.id, error: rpcError(error) },
          markActivity,
        );
      }
    });
  });

  return {
    connectionRegistry,
    attach(server: HttpServer) {
      server.on("upgrade", (request, socket, head) => {
        if (!request.url?.startsWith("/v1/ws")) return;
        if (!deps.isAllowedOrigin(request.headers.origin, deps.port)) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        wsServer.handleUpgrade(request, socket, head, (websocket) =>
          wsServer.emit("connection", websocket, request),
        );
      });
    },
    dispose() {
      unsubscribeEvents();
      connectionRegistry.clear();
      wsServer.close();
    },
  };
}
