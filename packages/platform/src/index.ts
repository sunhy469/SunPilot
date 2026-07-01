// ── 上下文 ────────────────────────────────────────────────────────────
export type { PlatformRequestContext } from "./context.js";
export { LOCAL_CONTEXT } from "./context.js";

// ── 会话服务 ──────────────────────────────────────────────────────────
export {
  ConversationService,
  ConversationNotFoundError,
  ConversationHasActiveRunsError,
} from "./conversations/conversation.service.js";
export type * from "./conversations/conversation.types.js";

// ── 数字世界服务 ──────────────────────────────────────────────────────
export { DigitalBeingService } from "./digital-world/digital-being.service.js";
export { WorldService } from "./digital-world/world.service.js";
export { TaskService, TaskNotFoundError } from "./digital-world/task.service.js";
export { TaskExecutor } from "./digital-world/task-executor.js";
export {
  BeingNotFoundError,
  InvalidBeingStatusError,
} from "./digital-world/digital-being.errors.js";
export type * from "./digital-world/digital-world.types.js";

// ── Platform 服务聚合 ─────────────────────────────────────────────────
export type { PlatformServices } from "./platform-services.js";
export { createPlatformServices } from "./platform-services.js";
