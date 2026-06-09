/**
 * 审计 Actor 统一枚举 — 从 @sunpilot/protocol 下沉，全仓统一来源。
 *
 * 所有 audit.create() 调用必须使用此枚举值。
 * 为避免 skill-runner、daemon、api 反向依赖 core，
 * 常量定义在 @sunpilot/protocol/src/audit.ts，此处仅 re-export。
 */
export { AUDIT_ACTORS, AuditActor } from "@sunpilot/protocol";
export type { AuditActor as AuditActorType } from "@sunpilot/protocol";
