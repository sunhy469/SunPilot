/**
 * Audit Actor 统一枚举 — 替换全仓硬编码字符串。
 *
 * 所有 audit.create() 调用必须使用此枚举值，
 * 确保审计日志中的 actor 字段一致可查询。
 *
 * 本文件位于 @sunpilot/protocol 而非 core，
 * 避免 skill-runner、daemon、api 为 actor 常量反向依赖 core。
 */
export const AUDIT_ACTORS = [
  "daemon",
  "system",
  "local-user",
  "agent",
  "user",
] as const;

export type AuditActor = (typeof AUDIT_ACTORS)[number];

export const AuditActor = {
  Daemon: "daemon",
  System: "system",
  LocalUser: "local-user",
  Agent: "agent",
  User: "user",
} as const satisfies Record<string, AuditActor>;
