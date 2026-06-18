import type { Permission } from "../safety/safety-types.js";

export interface NormalizedApprovalAction {
  skillId: string;
  arguments: Record<string, unknown>;
  permissions: Permission[];
  toolCallId?: string;
  messageId?: string;
}

export function normalizeRequestedAction(
  requestedAction: unknown,
): NormalizedApprovalAction | undefined {
  if (!requestedAction || typeof requestedAction !== "object") {
    return undefined;
  }
  const action = requestedAction as {
    skillId?: unknown;
    arguments?: unknown;
    permissions?: unknown;
    toolCallId?: unknown;
  };
  if (typeof action.skillId !== "string" || action.skillId.length === 0) {
    return undefined;
  }
  return {
    skillId: action.skillId,
    arguments:
      action.arguments && typeof action.arguments === "object"
        ? (action.arguments as Record<string, unknown>)
        : {},
    permissions: Array.isArray(action.permissions)
      ? action.permissions.filter(
          (item): item is Permission => typeof item === "string",
        )
      : [],
    toolCallId:
      typeof action.toolCallId === "string" ? action.toolCallId : undefined,
    messageId:
      typeof (action as { messageId?: unknown }).messageId === "string"
        ? (action as { messageId: string }).messageId
        : undefined,
  };
}
