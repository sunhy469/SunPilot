// ── 上下文 ────────────────────────────────────────────────────────────
export type { PlatformRequestContext } from "./context.js";
export { LOCAL_CONTEXT } from "./context.js";

// ── 会话服务 ──────────────────────────────────────────────────────────
export {
  ConversationService,
  ConversationNotFoundError,
} from "./conversations/conversation.service.js";
export type * from "./conversations/conversation.types.js";

// ── Platform 服务聚合 ─────────────────────────────────────────────────
export type { PlatformServices } from "./platform-services.js";
export { createPlatformServices } from "./platform-services.js";
