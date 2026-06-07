import { ZodError } from "zod";
import { RuntimeError } from "@sunpilot/core";
import {
  AGENT_ERROR_CODES,
  agentErrorToJsonRpcCode,
  JSON_RPC_ERROR_CODES,
  type AgentErrorCategory,
  type AgentErrorCode,
  type SunPilotEvent,
} from "@sunpilot/protocol";

const AGENT_ERROR_CODE_SET = new Set<string>(AGENT_ERROR_CODES);

/**
 * 将各类错误映射为 JSON-RPC 标准错误对象。
 *
 * 映射优先级：
 * 1. SyntaxError → JSON-RPC PARSE_ERROR
 * 2. ZodError → JSON-RPC INVALID_PARAMS
 * 3. 已知 AgentErrorCode → 通过 agentErrorToJsonRpcCode 映射
 * 4. RuntimeError → AGENT_DOMAIN_ERROR
 * 5. 其他 → INTERNAL_ERROR
 */
export function rpcError(error: unknown): {
  code: number;
  message: string;
  data?: unknown;
} {
  if (error instanceof SyntaxError) {
    return {
      code: JSON_RPC_ERROR_CODES.PARSE_ERROR,
      message: error.message,
    };
  }
  if (error instanceof ZodError) {
    return {
      code: JSON_RPC_ERROR_CODES.INVALID_PARAMS,
      message: "Invalid params",
      data: error.issues,
    };
  }

  const agentError = normalizeJsonRpcAgentError(error);
  if (agentError) {
    return {
      code: agentErrorToJsonRpcCode(agentError.code),
      message: agentError.message,
      data: {
        agentCode: agentError.code,
        category: agentError.category,
        retryable: agentError.retryable,
        ...(agentError.details ? { details: agentError.details } : {}),
      },
    };
  }

  if (error instanceof RuntimeError) {
    return {
      code: JSON_RPC_ERROR_CODES.AGENT_DOMAIN_ERROR,
      message: error.message,
      data: {
        agentCode: error.code,
        category: error.statusCode === 409 ? "run_state" : "internal",
        retryable: false,
      },
    };
  }
  return {
    code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
    message: error instanceof Error ? error.message : String(error),
  };
}

function normalizeJsonRpcAgentError(error: unknown):
  | {
      code: AgentErrorCode;
      message: string;
      category: AgentErrorCategory;
      retryable: boolean;
      details?: Record<string, unknown>;
    }
  | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    code?: unknown;
    message?: unknown;
    category?: unknown;
    retryable?: unknown;
    details?: unknown;
  };
  if (
    typeof record.code !== "string" ||
    !AGENT_ERROR_CODE_SET.has(record.code)
  ) {
    return undefined;
  }
  return {
    code: record.code as AgentErrorCode,
    message: typeof record.message === "string" ? record.message : record.code,
    category: normalizeAgentErrorCategory(record.category),
    retryable: typeof record.retryable === "boolean" ? record.retryable : false,
    ...(record.details && typeof record.details === "object"
      ? { details: record.details as Record<string, unknown> }
      : {}),
  };
}

function normalizeAgentErrorCategory(category: unknown): AgentErrorCategory {
  const categories: readonly AgentErrorCategory[] = [
    "permission",
    "approval",
    "run_state",
    "tool",
    "model",
    "context",
    "limit",
    "idempotency",
    "rate_limit",
    "internal",
  ];
  return categories.includes(category as AgentErrorCategory)
    ? (category as AgentErrorCategory)
    : "internal";
}

export function agentEventParams(
  event:
    | Pick<
        SunPilotEvent,
        "id" | "sequence" | "runId" | "conversationId" | "payload" | "createdAt"
      >
    | {
        id: string;
        sequence?: number;
        runId?: string;
        conversationId?: string;
        payload: unknown;
        createdAt: string;
      },
): {
  eventId: string;
  sequence: number;
  runId?: string;
  conversationId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
} {
  return {
    eventId: event.id,
    sequence: event.sequence ?? 0,
    runId: event.runId,
    conversationId: event.conversationId,
    createdAt: event.createdAt,
    payload:
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : { value: event.payload },
  };
}

/**
 * 将 SunPilotEvent 转换为 JSON-RPC 通知格式。
 *
 * 约定：
 * - agent.* 类型事件 → method 直接使用事件类型名（如 "agent.response.delta"）
 * - 非 agent.* 事件 → method 统一为 "agent.runtime.event"，原始事件放在 params.event 中
 *
 * 前端根据 method 字段区分事件类型并更新 UI。
 */
export function websocketNotificationForEvent(event: SunPilotEvent): {
  jsonrpc: "2.0";
  method: string;
  params: unknown;
} {
  if (typeof event.type === "string" && event.type.startsWith("agent.")) {
    return {
      jsonrpc: "2.0",
      method: event.type,
      params: agentEventParams(event),
    };
  }
  return {
    jsonrpc: "2.0",
    method: "agent.runtime.event",
    params: { runId: event.runId, event },
  };
}

export function agentErrorNotification(
  error: unknown,
  conversationId?: string,
): {
  jsonrpc: "2.0";
  method: "agent.error";
  params: ReturnType<typeof agentEventParams>;
} {
  return {
    jsonrpc: "2.0",
    method: "agent.error",
    params: agentEventParams({
      id: `evt_${crypto.randomUUID()}`,
      conversationId,
      payload: {
        conversationId,
        error: rpcError(error),
      },
      createdAt: new Date().toISOString(),
    }),
  };
}
