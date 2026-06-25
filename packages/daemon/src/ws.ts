import type { Server as HttpServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentEvent, AgentService } from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import {
  ConnectionRegistry,
  subscribeEventStreamer,
  JsonRpcRouter,
  rpcError,
} from "@sunpilot/api";

function sendJson(
  socket: WebSocket,
  payload: unknown,
  markActivity?: () => void,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
  markActivity?.();
}

/** Constant-time comparison of two secret strings; returns false on length mismatch. */
function safeEqualToken(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extract a bearer token from an `Authorization` header value. */
function extractBearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
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
  eventSubscribe(listener: (event: AgentEvent) => void): () => void;
  port: number;
  isAllowedOrigin: (origin: string | undefined, port: number) => boolean;
  /** When set, WebSocket upgrades must present this bearer token. */
  token?: string;
  /** When true, skip all auth checks (token + Origin) — for local dev/tests. */
  authDisabled?: boolean;
}) {
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const connectionRegistry = new ConnectionRegistry<WebSocket>(WebSocket.OPEN);
  const jsonRpcRouter = new JsonRpcRouter({
    getChatAgent: deps.getChatAgent,
    database: deps.database,
  });
  const unsubscribeEvents = subscribeEventStreamer({
    subscribe: deps.eventSubscribe,
    registry: connectionRegistry,
    send: (socket: WebSocket, notification: unknown) =>
      sendJson(socket, notification),
  });

  wsServer.on("connection", (socket, _request) => {
    const connection = connectionRegistry.add(socket);
    const markActivity = bindIdleTimeout(socket);
    const notify = (notification: unknown) =>
      sendJson(socket, notification, markActivity);
    socket.once("close", () => {
      connectionRegistry.remove(socket);
    });
    socket.on("message", async (raw) => {
      markActivity();
      let message: { id?: string; method?: string; params?: Record<string, unknown> } = {};
      try {
        message = JSON.parse(String(raw)) as typeof message;
        const response = await jsonRpcRouter.handle(message, {
          source: "web",
          connectionId: connection.id,
          runSubscriptions: connection.runSubscriptions,
          conversationSubscriptions: connection.conversationSubscriptions,
          notify,
        });
        // A1: JSON-RPC notifications (requests without an `id`) must not
        // receive a response. Sending one would drop the absent `id` during
        // JSON.stringify, producing an invalid response object.
        if (message.id === undefined) return;
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
        // A1: notifications (no id) get no response, not even an error.
        if (message.id === undefined) return;
        // A2: chat.send errors are reported solely through the JSON-RPC error
        // response below. Emitting a separate agent.error notification here
        // would double-report the failure to the client.
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

        // Token auth (C11): browsers cannot set headers on WS, so accept the
        // token via either `Authorization: Bearer <token>` or `?token=<token>`.
        // A valid token authorizes the upgrade; otherwise fall back to Origin.
        // When authDisabled is true (SUNPILOT_DISABLE_TOKEN_AUTH=1), skip all
        // checks — used for local development and integration tests.
        if (deps.authDisabled) {
          // no auth checks
        } else if (deps.token) {
          let presented: string | undefined = extractBearerToken(
            request.headers.authorization,
          );
          if (!presented) {
            try {
              presented = new URL(
                request.url ?? "",
                "http://localhost",
              ).searchParams.get("token") ?? undefined;
            } catch {
              presented = undefined;
            }
          }
          const tokenOk =
            presented !== undefined && safeEqualToken(presented, deps.token);
          if (!tokenOk && !deps.isAllowedOrigin(request.headers.origin, deps.port)) {
            socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
            socket.destroy();
            return;
          }
        } else if (!deps.isAllowedOrigin(request.headers.origin, deps.port)) {
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
      // Graceful shutdown (C11): close existing connections with 1001 so the
      // server can exit promptly instead of waiting for clients to disconnect.
      for (const client of wsServer.clients) {
        try {
          client.close(1001, "server shutting down");
        } catch {
          // Socket may already be closing — ignore.
        }
      }
      connectionRegistry.clear();
      wsServer.close();
    },
  };
}
