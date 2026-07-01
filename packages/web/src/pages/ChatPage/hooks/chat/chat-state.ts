import type { AgentArtifact, AgentEventRecord } from "../../../../features/agent-runtime/api";
import type {
  ChatSocketErrorResponse,
  ChatSocketEvent,
} from "../../../../features/chat/types";
import type {
  AgentActivity,
  AssistantMessagePart,
  ChatMessage,
} from "../../../../features/conversations/types";

export type ChatSocketPayload = ChatSocketEvent | ChatSocketErrorResponse;

/** JSON-RPC response result from chat.send ack */
export interface ChatSendAckResult {
  accepted?: boolean;
  resumed?: boolean;
  conversationId: string;
  runId: string;
  messageId: string;
  userMessageId?: string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: ChatSendAckResult;
  error?: { code: number; message: string };
}

export interface AgentArtifactPreview {
  id: string;
  runId?: string;
  name: string;
  type?: string;
  version?: number;
  createdAt: string;
}

export interface AgentArtifactSelection {
  artifact: AgentArtifact;
  content: string;
}

export function parseSocketPayload(
  data: string,
): ChatSocketPayload | JsonRpcResponse | undefined {
  const payload = JSON.parse(data) as
    | Partial<ChatSocketPayload>
    | Partial<JsonRpcResponse>
    | undefined;
  if (!payload || typeof payload !== "object") return undefined;

  // JSON-RPC response (chat.send ack, etc.)
  if (
    "jsonrpc" in payload &&
    payload.jsonrpc === "2.0" &&
    "id" in payload &&
    !("method" in payload)
  ) {
    return payload as JsonRpcResponse;
  }

  if ("error" in payload && typeof payload.error?.message === "string") {
    return { error: { message: payload.error.message } };
  }
  if ("method" in payload) {
    switch (payload.method) {
      case "agent.run.created":
      case "agent.run.started":
      case "agent.context.started":
      case "agent.context.completed":
      case "agent.intent.detected":
      case "agent.plan.created":
      case "agent.clarification.requested":
      case "agent.model.started":
      case "agent.model.delta":
      case "agent.model.completed":
      case "agent.model.failed":
      case "agent.run.completed":
      case "agent.run.failed":
      case "agent.run.cancelled":
      case "agent.error":
      case "agent.tool.selected":
      case "agent.tool.started":
      case "agent.tool.delta":
      case "agent.tool.completed":
      case "agent.tool.failed":
      case "agent.approval.required":
      case "agent.approval.approved":
      case "agent.approval.rejected":
      case "agent.approval.expired":
      case "agent.artifact.created":
      case "agent.memory.written":
      case "agent.run.interrupted":
      case "agent.message.started":
      case "agent.message.part.started":
      case "agent.message.part.delta":
      case "agent.message.part.updated":
      case "agent.message.completed":
      case "pong":
        return normalizeSocketEvent(payload as ChatSocketEvent);
      default:
        return undefined;
    }
  }
  return undefined;
}

export function normalizeSocketEvent(event: ChatSocketEvent): ChatSocketEvent {
  if (event.method === "pong") return event;
  const params = event.params as unknown;
  if (!isAgentEnvelope(params)) return event;
  return {
    ...event,
    id: params.eventId,
    sequence: params.sequence,
    runId: params.runId,
    conversationId: params.conversationId,
    createdAt: params.createdAt,
    params: params.payload,
  } as ChatSocketEvent;
}

export function isAgentEnvelope(value: unknown): value is {
  eventId: string;
  sequence: number;
  runId?: string;
  conversationId?: string;
  createdAt: string;
  payload: Record<string, unknown>;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    eventId?: unknown;
    sequence?: unknown;
    createdAt?: unknown;
    payload?: unknown;
  };
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.sequence === "number" &&
    typeof candidate.createdAt === "string" &&
    !!candidate.payload &&
    typeof candidate.payload === "object"
  );
}

export const lastDeltaIndexByPartId = new Map<string, number>();

// ── Unified assistant message reducer (§P0: idempotent message lifecycle) ──
// Handles all agent.message.* events with idempotent guarantees:
//   - messageId is the dedup key for assistant messages
//   - partId is the dedup key for parts
//   - completed is final override, not incremental append

/**
 * Local placeholder status part inserted on agent.message.started
 * so the UI shows "正在理解需求..." immediately via ThinkingProcessSection,
 * instead of falling through to the static fallback branch.
 * Replaced/removed when the first real agent.message.part.started arrives.
 */
export const LOCAL_PENDING_STATUS_PART: AssistantMessagePart = {
  id: "__local_pending",
  type: "status",
  label: "正在理解需求...",
  status: "running",
  runId: "",
  createdAt: "",
  metadata: { phase: "local_pending" },
};

export function assistantMessageReducer(
  items: ChatMessage[],
  event: { method: string; params: Record<string, unknown> },
  conversationId: string,
): ChatMessage[] {
  if (event.method === "agent.message.started") {
    const msgParams = event.params as {
      runId: string;
      conversationId: string;
      messageId: string;
    };

    // If a message with this messageId already exists, just update it
    if (items.some((m) => m.id === msgParams.messageId)) {
      return items.map((m) =>
        m.id === msgParams.messageId
          ? {
              ...m,
              runId: msgParams.runId,
              status: "streaming" as const,
              // Insert local pending status part if no parts yet
              parts:
                (m.parts ?? []).length > 0
                  ? m.parts
                  : [LOCAL_PENDING_STATUS_PART],
            }
          : m,
      );
    }

    // Find the best pending placeholder to bind:
    // 1. Prefer the last assistant with conversationId === "pending"
    // 2. Then the last assistant with matching conversationId that is still pending
    const pendingPlaceholderIdx = findLastIndex(
      items,
      (m) =>
        m.role === "assistant" &&
        m.status === "pending" &&
        (m.conversationId === "pending" ||
          m.conversationId === (msgParams.conversationId || conversationId)),
    );

    if (pendingPlaceholderIdx >= 0) {
      return items.map((m, idx) =>
        idx === pendingPlaceholderIdx
          ? {
              ...m,
              id: msgParams.messageId,
              runId: msgParams.runId,
              conversationId: msgParams.conversationId ?? conversationId,
              status: "streaming" as const,
              parts: [LOCAL_PENDING_STATUS_PART],
            }
          : m,
      );
    }

    // No placeholder found — create a new streaming assistant message
    return [
      ...items,
      {
        id: msgParams.messageId,
        runId: msgParams.runId,
        conversationId: msgParams.conversationId ?? conversationId,
        role: "assistant" as const,
        content: "",
        createdAt: new Date().toISOString(),
        status: "streaming" as const,
        activities: [],
        parts: [LOCAL_PENDING_STATUS_PART],
      },
    ];
  }

  if (event.method === "agent.message.part.started") {
    const partParams = event.params as {
      messageId: string;
      part: Record<string, unknown>;
    };
    const partId = partParams.part.id as string | undefined;
    const incomingPart = partParams.part as unknown as AssistantMessagePart;

    return items.map((item) => {
      if (item.id !== partParams.messageId) return item;
      const parts = item.parts ?? [];
      // Remove local pending placeholder when the first real part arrives
      const withoutLocal = parts.filter((p) => p.id !== "__local_pending");
      // Upsert by part.id: if part already exists, merge; otherwise append
      const existingIdx =
        partId != null ? withoutLocal.findIndex((p) => p.id === partId) : -1;
      const nextParts =
        existingIdx >= 0
          ? withoutLocal.map((p, i) =>
              i === existingIdx ? { ...p, ...incomingPart } : p,
            )
          : [...withoutLocal, incomingPart];
      return { ...item, parts: nextParts };
    });
  }

  if (event.method === "agent.message.part.delta") {
    const deltaParams = event.params as {
      conversationId?: string;
      messageId: string;
      partId: string;
      delta: string;
      deltaIndex?: number;
    };

    // Delta dedup: if deltaIndex is provided, skip already-seen deltas
    if (typeof deltaParams.deltaIndex === "number") {
      const key = `${deltaParams.messageId}:${deltaParams.partId}`;
      const lastIndex = lastDeltaIndexByPartId.get(key) ?? -1;
      if (deltaParams.deltaIndex <= lastIndex) {
        return items; // Skip duplicate or out-of-order delta
      }
      lastDeltaIndexByPartId.set(key, deltaParams.deltaIndex);
    }

    return upsertTextPartDelta(items, {
      conversationId: deltaParams.conversationId ?? conversationId,
      messageId: deltaParams.messageId,
      partId: deltaParams.partId,
      delta: deltaParams.delta,
    });
  }

  if (event.method === "agent.message.part.updated") {
    const updateParams = event.params as {
      messageId: string;
      partId: string;
      patch: Record<string, unknown>;
    };
    return items.map((item) =>
      item.id === updateParams.messageId
        ? {
            ...item,
            parts: (item.parts ?? []).map((part) =>
              part.id === updateParams.partId
                ? { ...part, ...updateParams.patch }
                : part,
            ),
          }
        : item,
    );
  }

  if (event.method === "agent.message.completed") {
    const completedParams = event.params as {
      runId?: string;
      conversationId?: string;
      messageId: string;
      content: string;
      parts?: Array<Record<string, unknown>>;
      cards?: Array<{
        type: string;
        title?: import("../../../../rich-cards/types").RichTextValue;
        subtitle?: import("../../../../rich-cards/types").RichTextValue;
        data: Record<string, unknown>;
      }>;
    };

    // Idempotent: if message already completed with same content, skip to avoid re-render
    const existing = items.find((m) => m.id === completedParams.messageId);
    const completedParts = normalizeCompletedAssistantParts(
      resolveCompletedAssistantParts(
        completedParams.parts,
        existing,
        completedParams.content,
      ),
    );
    if (
      existing &&
      existing.status === "completed" &&
      existing.content === completedParams.content &&
      !hasOpenAssistantParts(existing.parts)
    ) {
      return items;
    }

    // If message exists, replace with final state
    if (existing) {
      // Clear delta index tracking for this message's parts
      for (const key of lastDeltaIndexByPartId.keys()) {
        if (key.startsWith(completedParams.messageId + ":")) {
          lastDeltaIndexByPartId.delete(key);
        }
      }
      return items.map((m) =>
        m.id === completedParams.messageId
          ? {
              ...m,
              content: completedParams.content,
              parts: completedParts,
              status: "completed" as const,
              cards: (completedParams.cards as ChatMessage["cards"]) ?? m.cards,
            }
          : m,
      );
    }

    // Message not found — create a completed assistant message
    return [
      ...items,
      {
        id: completedParams.messageId,
        conversationId: completedParams.conversationId ?? conversationId,
        role: "assistant" as const,
        content: completedParams.content,
        createdAt: new Date().toISOString(),
        status: "completed" as const,
        activities: [],
        parts: completedParts,
        cards: completedParams.cards as ChatMessage["cards"],
      },
    ];
  }

  return items;
}

/** findLastIndex polyfill — returns -1 if no match */
export function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

export function hasOpenAssistantParts(parts?: ChatMessage["parts"]): boolean {
  return (parts ?? []).some((part) => {
    if (part.type === "status") return part.status === "running";
    if (part.type === "tool_use")
      return part.status === "pending" || part.status === "running";
    if (part.type === "text") return part.status === "streaming";
    return false;
  });
}

export function normalizeCompletedAssistantParts(
  parts: Array<Record<string, unknown>>,
): ChatMessage["parts"] {
  const completedAt = new Date().toISOString();
  return parts.map((part) => {
    if (part.type === "status" && part.status === "running") {
      const metadata =
        part.metadata && typeof part.metadata === "object"
          ? (part.metadata as Record<string, unknown>)
          : {};
      return {
        ...part,
        status: "completed",
        completedAt:
          typeof part.completedAt === "string" ? part.completedAt : completedAt,
        metadata: {
          ...metadata,
          phase: "completed",
        },
      } as unknown as AssistantMessagePart;
    }
    if (
      part.type === "tool_use" &&
      (part.status === "pending" || part.status === "running")
    ) {
      return {
        ...part,
        status: "completed",
      } as unknown as AssistantMessagePart;
    }
    if (part.type === "text" && part.status === "streaming") {
      return {
        ...part,
        status: "completed",
        completedAt:
          typeof part.completedAt === "string" ? part.completedAt : completedAt,
      } as unknown as AssistantMessagePart;
    }
    return part as unknown as AssistantMessagePart;
  });
}

export function resolveCompletedAssistantParts(
  incomingParts: Array<Record<string, unknown>> | undefined,
  existing: ChatMessage | undefined,
  content: string,
): Array<Record<string, unknown>> {
  if (Array.isArray(incomingParts)) return incomingParts;

  const existingParts = existing?.parts?.filter(
    (part) => part.id !== "__local_pending",
  );
  if (existingParts && existingParts.length > 0) {
    return existingParts as unknown as Array<Record<string, unknown>>;
  }

  if (content.trim().length === 0) return [];
  return [
    {
      id: "final_text",
      type: "text",
      content,
      source: "model",
      status: "completed",
      createdAt: new Date().toISOString(),
    },
  ];
}

export function findActiveAssistantMessageIndex(messages: ChatMessage[]): number {
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    const item = messages[idx];
    if (
      item?.role === "assistant" &&
      (item.status === "pending" || item.status === "streaming")
    ) {
      return idx;
    }
  }
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    if (messages[idx]?.role === "assistant") return idx;
  }
  return -1;
}

export function upsertTextPartDelta(
  messages: ChatMessage[],
  input: {
    conversationId: string;
    messageId: string;
    partId: string;
    delta: string;
  },
): ChatMessage[] {
  // §5.8: Don't append deltas to completed messages — the stream is closed.
  // This prevents duplicate content when a late delta arrives after
  // agent.message.completed.
  const existing = messages.find((m) => m.id === input.messageId);
  if (existing && existing.status === "completed") return messages;

  const applyDelta = (item: ChatMessage): ChatMessage => {
    const parts = item.parts ?? [];
    const hasPart = parts.some((part) => part.id === input.partId);
    const nextParts = hasPart
      ? parts.map((part) =>
          part.type === "text" && part.id === input.partId
            ? { ...part, content: (part.content ?? "") + input.delta }
            : part,
        )
      : [
          ...parts,
          {
            id: input.partId,
            type: "text" as const,
            content: input.delta,
            source: "model" as const,
            status: "streaming" as const,
            createdAt: new Date().toISOString(),
          },
        ];
    return { ...item, status: "streaming", parts: nextParts };
  };

  let found = false;
  const updated = messages.map((item) => {
    if (item.id !== input.messageId) return item;
    found = true;
    return applyDelta(item);
  });
  if (found) return updated;

  return [
    ...messages,
    applyDelta({
      id: input.messageId,
      conversationId: input.conversationId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      status: "streaming",
      activities: [],
      parts: [],
    }),
  ];
}

/**
 * §P1-4: Explicit event visibility classification.
 *
 * Every event in the protocol's AGENT_EVENT_TYPES MUST be listed here
 * with one of four visibility levels:
 *   - "visible"  → mapped to a user-visible AgentActivity
 *   - "status"   → drives UI state (sendState/status/pending) but no activity
 *   - "debug"    → only shown in the debug panel, no UI impact
 *   - "ignored"  → intentionally not handled (e.g. pong)
 *
 * When new events are added to the protocol, they MUST be added here
 * to avoid silent no-ops.
 */
export const AGENT_EVENT_VISIBILITY: Record<string, "visible" | "status" | "debug" | "ignored"> = {
  // ── User-visible activities ──────────────────────────────────────
  "agent.tool.started": "visible",
  "agent.tool.delta": "visible",
  "agent.tool.completed": "visible",
  "agent.tool.failed": "visible",
  "agent.error": "visible",

  // ── Status-driving events (handled in live handler, no activity) ─
  "agent.run.created": "status",
  "agent.run.started": "status",
  "agent.run.completed": "status",
  "agent.run.failed": "status",
  "agent.run.cancelled": "status",
  "agent.run.interrupted": "status",
  "agent.message.started": "status",
  "agent.message.part.started": "status",
  "agent.message.part.delta": "status",
  "agent.message.part.updated": "status",
  "agent.message.completed": "status",
  "agent.approval.required": "status",
  "agent.approval.approved": "status",
  "agent.approval.rejected": "status",
  "agent.approval.expired": "status",
  "agent.artifact.created": "status",
  "agent.memory.written": "status",

  // ── Debug-only events (no user-visible activity) ─────────────────
  "agent.context.started": "debug",
  "agent.context.completed": "debug",
  "agent.intent.detected": "debug",
  "agent.plan.created": "debug",
  "agent.tool.selected": "debug",
  "agent.model.started": "debug",
  "agent.model.delta": "debug",
  "agent.model.completed": "debug",
  "agent.model.failed": "debug",
  "agent.clarification.requested": "debug",

  // ── Ignored ──────────────────────────────────────────────────────
  "pong": "ignored",
};

/**
 * Map agent events to user-visible activities.
 *
 * Only events classified as "visible" in AGENT_EVENT_VISIBILITY produce
 * an AgentActivity. All other events are classified but do not produce
 * activities — they are either status-driving, debug-only, or ignored.
 *
 * The debug panel shows full event traces separately.
 */
export function activityFromAgentEvent(
  event: ChatSocketEvent,
): AgentActivity | undefined {
  if (event.method === "pong") return undefined;
  const createdAt = event.createdAt ?? new Date().toISOString();
  const id = event.id ?? `${event.method}_${createdAt}`;

  // Exhaustive check: if an event is not in the visibility map, log a warning
  const visibility = AGENT_EVENT_VISIBILITY[event.method];
  if (!visibility) {
    if (typeof console !== "undefined") {
      console.warn(
        `[activityFromAgentEvent] Unmapped event: "${event.method}". ` +
        `Add it to AGENT_EVENT_VISIBILITY with an appropriate level.`,
      );
    }
    return undefined;
  }

  // Only "visible" events produce activities
  if (visibility !== "visible") return undefined;

  switch (event.method) {
    // ── Tool execution (user-visible) ──────────────────────────
    case "agent.tool.started":
      return {
        id,
        kind: "tool",
        label: `正在调用工具: ${event.params.name}`,
        detail: event.params.skillId,
        status: "running",
        createdAt,
      };
    case "agent.tool.delta":
      return {
        id,
        kind: "tool",
        label: event.params.delta || "工具正在执行",
        status: "running",
        createdAt,
      };
    case "agent.tool.completed":
      return {
        id,
        kind: "result",
        label: "工具调用完成",
        detail: event.params.summary,
        status: "completed",
        createdAt,
      };
    case "agent.tool.failed":
      return {
        id,
        kind: "error",
        label: "工具调用失败",
        detail: event.params.error.message,
        status: "failed",
        createdAt,
      };

    // ── Agent-level errors (user-visible) ──────────────────────
    case "agent.error":
      return {
        id,
        kind: "error",
        label: "请求失败",
        detail: event.params.error?.message ?? event.params.message,
        status: "failed",
        createdAt,
      };

    default:
      return undefined;
  }
}

// W6: WebSocket reconnection parameters (exponential backoff).
export const RECONNECT_BASE_DELAY = 1000; // initial 1s
export const RECONNECT_MAX_DELAY = 30_000; // cap at 30s
export const RECONNECT_MAX_ATTEMPTS = 10; // give up after 10 tries
// W6: pong timeout — if no pong arrives within this window after a ping, the
// connection is considered half-open and we close it to trigger a reconnect.
export const PONG_TIMEOUT_MS = 30_000;
