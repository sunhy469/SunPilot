// ── Composition ──────────────────────────────────────────────────────
export type { SunPilotApiDeps } from "./composition/api-deps.js";

// ── HTTP ─────────────────────────────────────────────────────────────
export { registerSunPilotApiRoutes } from "./http/register-routes.js";
export * from "./http/schemas.js";

// ── WebSocket ────────────────────────────────────────────────────────
export { JsonRpcRouter } from "./ws/json-rpc-router.js";
export type {
  JsonRpcCommand,
  JsonRpcConnectionContext,
  JsonRpcRouterDeps,
  JsonRpcRouterResponse,
} from "./ws/json-rpc-router.js";
export {
  rpcError,
  agentEventParams,
  websocketNotificationForEvent,
  agentErrorNotification,
} from "./ws/ws-protocol.js";
export { subscribeEventStreamer } from "./ws/event-streamer.js";
export {
  ConnectionRegistry,
  type WebSocketLike,
  type ConnectionState,
} from "./ws/connection-registry.js";
