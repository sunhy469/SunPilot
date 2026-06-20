/**
 * 平台请求上下文 — 为多租户、多用户、多端预留。
 * 第一阶段 `tenantId`、`userId` 可选，本地单用户模式兼容。
 */
export interface PlatformRequestContext {
  tenantId?: string;
  userId?: string;
  actorType: "anonymous-local" | "user" | "service";
  clientType?: "web" | "mac" | "windows" | "mobile" | "api";
}

/** 本地单用户模式的默认上下文。 */
export const LOCAL_CONTEXT: PlatformRequestContext = {
  actorType: "anonymous-local",
  clientType: "web",
};
