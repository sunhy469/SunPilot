import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createRequest } from "../../../shared/api/client";
import {
  approveAgentApproval,
  getAgentArtifact,
  getAgentArtifactContent,
  listPendingApprovals,
  rejectAgentApproval,
  replayConversationEvents,
  type AgentApproval,
  type AgentArtifact,
  type AgentEventRecord,
} from "../../../features/agent-runtime/api";
import type {
  AttachmentRef,
  ChatSocketErrorResponse,
  ChatSocketEvent,
} from "../../../features/chat/types";
import {
  chatSocketUrl,
  createChatSocket,
  sendChatMessage,
  sendChatStop,
} from "../../../features/chat/ws";
import { validateAttachmentRefsForSend } from "../../../features/chat/attachment-utils";
import type {
  AgentActivity,
  ChatMessage,
  AssistantMessagePart,
} from "../../../features/conversations/types";
import type { RichCardAction } from "../../../rich-cards/types";
import type { ChatViewState, LocalSendState } from "../types";

type ChatSocketPayload = ChatSocketEvent | ChatSocketErrorResponse;

/** JSON-RPC response result from chat.send ack */
interface ChatSendAckResult {
  accepted: boolean;
  conversationId: string;
  runId: string;
  messageId: string;
}

interface JsonRpcResponse {
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

function parseSocketPayload(
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

function normalizeSocketEvent(event: ChatSocketEvent): ChatSocketEvent {
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

function isAgentEnvelope(value: unknown): value is {
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

const lastDeltaIndexByPartId = new Map<string, number>();

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
const LOCAL_PENDING_STATUS_PART: AssistantMessagePart = {
  id: "__local_pending",
  type: "status",
  label: "正在理解需求...",
  status: "running",
  runId: "",
  createdAt: "",
  metadata: { phase: "local_pending" },
};

function assistantMessageReducer(
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
      parts: Array<Record<string, unknown>>;
      cards?: Array<{
        type: string;
        title?: import("../../../rich-cards/types").RichTextValue;
        subtitle?: import("../../../rich-cards/types").RichTextValue;
        data: Record<string, unknown>;
      }>;
    };
    const completedParts = normalizeCompletedAssistantParts(
      completedParams.parts,
    );

    // Idempotent: if message already completed with same content, skip to avoid re-render
    const existing = items.find((m) => m.id === completedParams.messageId);
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
function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i]!)) return i;
  }
  return -1;
}

function hasOpenAssistantParts(parts?: ChatMessage["parts"]): boolean {
  return (parts ?? []).some((part) => {
    if (part.type === "status") return part.status === "running";
    if (part.type === "tool_use")
      return part.status === "pending" || part.status === "running";
    if (part.type === "text") return part.status === "streaming";
    return false;
  });
}

function normalizeCompletedAssistantParts(
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

function findActiveAssistantMessageIndex(messages: ChatMessage[]): number {
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

function upsertTextPartDelta(
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
const AGENT_EVENT_VISIBILITY: Record<string, "visible" | "status" | "debug" | "ignored"> = {
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
function activityFromAgentEvent(
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

export function useChat(
  conversationId: string,
  setConversationId: (id: string) => void,
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
  onConversationCreated?: (conversationId: string) => void,
) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"online" | "offline" | "thinking">(
    "offline",
  );
  const [sendState, setSendState] = useState<LocalSendState>("editing");
  const [toolName, setToolName] = useState<string | null>(null);
  const toolCallCountRef = useRef(0);
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const responseTimerRef = useRef<number | null>(null);
  const keepAliveTimerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const onConversationCreatedRef = useRef(onConversationCreated);
  onConversationCreatedRef.current = onConversationCreated;
  const activeRunIdRef = useRef<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const requestRef = useRef(createRequest());
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [artifacts, setArtifacts] = useState<AgentArtifactPreview[]>([]);
  const [selectedArtifact, setSelectedArtifact] =
    useState<AgentArtifactSelection | null>(null);
  const seenEventIdsRef = useRef(new Set<string>());
  const lastSequenceRef = useRef(0);
  /** Maps JSON-RPC request id → clientRequestId for chat.send ack binding */
  const pendingAcksRef = useRef(new Map<string, string>());

  const setPendingState = useCallback((next: boolean) => {
    pendingRef.current = next;
    setPending(next);
  }, []);

  const clearResponseTimer = useCallback(() => {
    if (responseTimerRef.current === null) return;
    window.clearTimeout(responseTimerRef.current);
    responseTimerRef.current = null;
  }, []);

  const startResponseTimer = useCallback(() => {
    clearResponseTimer();
    responseTimerRef.current = window.setTimeout(() => {
      setPendingState(false);
      setStatus(
        socketRef.current?.readyState === WebSocket.OPEN ? "online" : "offline",
      );
      setError("Chat request timed out before the daemon returned a response.");
    }, 90_000);
  }, [clearResponseTimer, setPendingState]);

  // ── Unified finish helper (§P1-2) ────────────────────────────────
  // All terminal events (run.completed/failed/cancelled/interrupted,
  // message.completed) MUST call this instead of duplicating cleanup.
  const finishActiveRun = useCallback(
    (outcome: { sendState: "completed" | "failed"; error?: string }) => {
      clearResponseTimer();
      setSendState(outcome.sendState);
      setStatus("online");
      setPendingState(false);
      if (outcome.error) setError(outcome.error);
      setToolName(null);
      toolCallCountRef.current = 0;
      activeRunIdRef.current = null;
      setActiveRunId(null);
    },
    [clearResponseTimer, setPendingState],
  );

  // ── Unified mark-active helper (§P1-3) ──────────────────────────
  // Called when any event indicates the run is actively progressing.
  const markRunActive = useCallback(
    (runId: string, uiState?: { sendState?: LocalSendState; status?: "online" | "offline" | "thinking" }) => {
      activeRunIdRef.current = runId;
      setActiveRunId(runId);
      if (uiState?.sendState) setSendState(uiState.sendState);
      if (uiState?.status) setStatus(uiState.status);
      startResponseTimer();
    },
    [startResponseTimer],
  );

  const closeSocket = useCallback(() => {
    if (keepAliveTimerRef.current !== null) {
      window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.close(1000);
      socketRef.current = null;
    }
  }, []);

  const applyAgentEvent = useCallback(
    (event: ChatSocketEvent | AgentEventRecord) => {
      const method = "method" in event ? event.method : event.type;
      const params = "method" in event ? event.params : event.payload;
      if ("id" in event && event.id) seenEventIdsRef.current.add(event.id);
      if ("sequence" in event && typeof event.sequence === "number") {
        lastSequenceRef.current = Math.max(
          lastSequenceRef.current,
          event.sequence,
        );
      }
      if (method === "agent.approval.required") {
        const payload = params as {
          runId: string;
          approvalId: string;
          title: string;
          riskLevel: AgentApproval["risk"];
        };
        setApprovals((items) => {
          if (items.some((item) => item.id === payload.approvalId))
            return items;
          return [
            ...items,
            {
              id: payload.approvalId,
              runId: payload.runId,
              status: "pending",
              risk: payload.riskLevel,
              title: payload.title,
              createdAt: new Date().toISOString(),
            },
          ];
        });
        return;
      }

      if (method === "agent.artifact.created") {
        const payload = params as {
          runId?: string;
          artifactId: string;
          name?: string;
          type?: string;
          version?: number;
        };
        if (typeof payload.artifactId === "string") {
          setArtifacts((items) => {
            if (items.some((item) => item.id === payload.artifactId)) {
              return items;
            }
            return [
              ...items,
              {
                id: payload.artifactId,
                runId: payload.runId,
                name: payload.name ?? payload.artifactId,
                type: payload.type,
                version: payload.version,
                createdAt:
                  ("createdAt" in event && event.createdAt) ||
                  new Date().toISOString(),
              },
            ].slice(-12);
          });
        }
      }

      if (
        method === "agent.approval.approved" ||
        method === "agent.approval.rejected" ||
        method === "agent.approval.expired"
      ) {
        const payload = params as { approvalId: string; decidedBy?: string; strategy?: string; runId?: string };
        const status =
          method === "agent.approval.approved"
            ? "approved"
            : method === "agent.approval.expired"
              ? "expired"
              : "rejected";
        setApprovals((items) =>
          items.map((item) =>
            item.id === payload.approvalId
              ? {
                  ...item,
                  status,
                  decidedBy: payload.decidedBy,
                  decidedAt: new Date().toISOString(),
                }
              : item,
          ),
        );

        // §P0-2: Defensive cleanup — if the rejection strategy is terminal
        // (interrupt/cancel), the backend should emit agent.run.interrupted/cancelled,
        // but we also clean up here as defense-in-depth in case that event is delayed.
        if (method === "agent.approval.rejected") {
          const strategy = payload.strategy;
          if (strategy === "interrupt" || strategy === "cancel") {
            // Only clean up if this run is still active
            if (activeRunIdRef.current === payload.runId) {
              finishActiveRun({ sendState: "failed" });
              setMessages((items) =>
                items.map((item) =>
                  item.role === "assistant" && item.status === "streaming"
                    ? { ...item, status: "stopped" as const }
                    : item,
                ),
              );
            }
          }
        }

        // §P0-2: Approval expired — backend should emit agent.run.cancelled,
        // but we also clean up here as defense-in-depth.
        if (method === "agent.approval.expired") {
          if (activeRunIdRef.current === payload.runId) {
            finishActiveRun({ sendState: "failed" });
            setMessages((items) =>
              items.map((item) =>
                item.role === "assistant" && item.status === "streaming"
                  ? { ...item, status: "stopped" as const }
                  : item,
              ),
            );
          }
        }

        return;
      }

      if (method === "agent.run.created") {
        const payload = params as { runId: string; conversationId?: string };
        activeRunIdRef.current = payload.runId;
        setActiveRunId(payload.runId);
        // If backend auto-created a conversation, update local state
        if (payload.conversationId && !conversationId) {
          setConversationId(payload.conversationId);
          onConversationCreatedRef.current?.(payload.conversationId);
        }
      }

      // §P1-1: Handle agent.run.started — the run has actually begun execution
      if (method === "agent.run.started") {
        const payload = params as { runId: string; conversationId?: string; originalRunId?: string; attemptAction?: string };
        activeRunIdRef.current = payload.runId;
        setActiveRunId(payload.runId);
        // For resume/retry, sync conversationId if present
        if (payload.conversationId) {
          setConversationId(payload.conversationId);
        }
      }
      if (
        method === "agent.run.completed" ||
        method === "agent.run.failed" ||
        method === "agent.run.cancelled" ||
        method === "agent.run.interrupted"
      ) {
        activeRunIdRef.current = null;
        setActiveRunId(null);
      }

      // ── Message content-block events (§P0: unified reducer) ──
      // All agent.message.* mutations go through assistantMessageReducer
      // for idempotent guarantees. Both live WebSocket events AND
      // replayConversationEvents() results share this path.
      const messageMethods = [
        "agent.message.started",
        "agent.message.part.started",
        "agent.message.part.delta",
        "agent.message.part.updated",
        "agent.message.completed",
      ];
      if (messageMethods.includes(method)) {
        setMessages((items) =>
          assistantMessageReducer(
            items,
            { method, params: params as Record<string, unknown> },
            conversationId,
          ),
        );
        return;
      }
    },
    [conversationId, setConversationId, setMessages],
  );

  const appendAssistantActivity = useCallback(
    (activity: AgentActivity) => {
      setMessages((items) => {
        const targetIdx = findActiveAssistantMessageIndex(items);
        if (targetIdx < 0) return items;
        const target = items[targetIdx]!;
        // §Cleanup: Don't accumulate activities for parts-based messages.
        // Parts rendering replaces AgentActivityList for new content-block messages.
        if (target.parts && target.parts.length > 0) return items;
        if (target.activities?.some((item) => item.id === activity.id)) {
          return items;
        }
        return items.map((item, idx) =>
          idx === targetIdx
            ? {
                ...item,
                activities: [...(item.activities ?? []), activity].slice(-16),
              }
            : item,
        );
      });
    },
    [setMessages],
  );

  const refreshApprovals = useCallback(async () => {
    try {
      const response = await listPendingApprovals(requestRef.current);
      setApprovals(Array.isArray(response.items) ? response.items : []);
    } catch {
      // Best effort; chat remains usable without the approval strip.
    }
  }, []);

  const ensureSocket = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN)
      return socketRef.current;
    const socket = createChatSocket();
    socketRef.current = socket;
    const openTimer = window.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.close();
        setPendingState(false);
        setStatus("offline");
        setError(
          `无法连接到 daemon WebSocket：${chatSocketUrl()}。请确认页面地址和后端代理配置一致。`,
        );
      }
    }, 10_000);
    socket.addEventListener("open", () => {
      window.clearTimeout(openTimer);
      setStatus((current) => (current === "thinking" ? "thinking" : "online"));
      setError("");
      if (keepAliveTimerRef.current !== null)
        window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: crypto.randomUUID(),
              method: "ping",
              params: {},
            }),
          );
        }
      }, 25_000);
    });
    socket.addEventListener("error", () => {
      const wasPending = pendingRef.current;
      window.clearTimeout(openTimer);
      clearResponseTimer();
      setPendingState(false);
      setStatus("offline");
      if (wasPending)
        setError(
          `WebSocket 连接失败：${chatSocketUrl()}。请在 Network 里查看 v1/ws 的状态码。`,
        );
    });
    socket.addEventListener("close", (event) => {
      const wasPending = pendingRef.current;
      window.clearTimeout(openTimer);
      clearResponseTimer();
      if (keepAliveTimerRef.current !== null) {
        window.clearInterval(keepAliveTimerRef.current);
        keepAliveTimerRef.current = null;
      }
      if (socketRef.current === socket) socketRef.current = null;
      setStatus("offline");
      setPendingState(false);
      if (wasPending && event.code !== 1000 && event.code !== 4000) {
        setError(event.reason || "WebSocket 连接已断开，请重试。");
      }
    });
    socket.addEventListener("message", (raw) => {
      let payload: ChatSocketPayload | JsonRpcResponse | undefined;
      try {
        payload = parseSocketPayload(String(raw.data));
      } catch {
        return;
      }
      if (!payload) return;
      if ("error" in payload && payload.error) {
        clearResponseTimer();
        setError(payload.error.message);
        setPendingState(false);
        setStatus("online");
        return;
      }

      // ── JSON-RPC response (chat.send ack) ─────────────────────
      // When the server acknowledges chat.send, bind the local optimistic
      // user message to the server-confirmed messageId and conversationId.
      if (
        "result" in payload &&
        payload.result &&
        "messageId" in payload.result
      ) {
        const ack = payload.result as ChatSendAckResult;
        const rpcId = (payload as JsonRpcResponse).id;
        const clientRequestId = pendingAcksRef.current.get(rpcId);
        if (clientRequestId) {
          pendingAcksRef.current.delete(rpcId);
        }

        if (ack.accepted && ack.messageId) {
          const matchClientRequestId = clientRequestId;
          setMessages((items) =>
            items.map((item) => {
              // Match by clientRequestId (preferred) or by local_ prefix + pending conversationId
              if (
                item.role === "user" &&
                (matchClientRequestId
                  ? item.clientRequestId === matchClientRequestId
                  : item.id.startsWith("local_") &&
                    item.conversationId === "pending")
              ) {
                return {
                  ...item,
                  id: ack.messageId,
                  conversationId: ack.conversationId || item.conversationId,
                  clientRequestId: item.clientRequestId,
                };
              }
              return item;
            }),
          );
          // Also update the assistant placeholder's conversationId
          if (ack.conversationId) {
            setMessages((items) =>
              items.map((item) => {
                if (
                  item.role === "assistant" &&
                  item.status === "pending" &&
                  item.conversationId === "pending"
                ) {
                  return { ...item, conversationId: ack.conversationId };
                }
                return item;
              }),
            );
          }
        }
        return;
      }

      // From here, payload must be a ChatSocketEvent (notification)
      const event = payload as ChatSocketEvent;
      // ── Agent error events ────────────────────────────────────
      if (event.method === "agent.error") {
        finishActiveRun({
          sendState: "failed",
          error:
            event.params.error?.message ??
            event.params.message ??
            "Agent request failed.",
        });
        applyAgentEvent(event);
        const activity = activityFromAgentEvent(event);
        if (activity) {
          appendAssistantActivity(activity);
        }
        return;
      }

      if (event.method === "pong") return;

      applyAgentEvent(event);
      const activity = activityFromAgentEvent(event);
      if (activity) {
        appendAssistantActivity(activity);
      }

      if (event.method === "agent.run.created") {
        activeRunIdRef.current = event.params.runId ?? null;
        setActiveRunId(event.params.runId);
        setConversationId(event.params.conversationId);
        setSendState("running");
        setStatus("thinking");
        // Replace "pending" conversationId on all local messages with the real one
        setMessages((items) =>
          items.map((item) =>
            item.conversationId === "pending"
              ? { ...item, conversationId: event.params.conversationId }
              : item,
          ),
        );
      }

      // §P1-1: agent.run.started — run has actually begun execution
      // For live events, this signals the run is actively running.
      // For resume/retry, this is the primary "run is active again" signal.
      if (event.method === "agent.run.started") {
        markRunActive(event.params.runId, { sendState: "running", status: "thinking" });
        if (event.params.conversationId) {
          setConversationId(event.params.conversationId);
        }
      }

      // ── Tool call tracking ──────────────────────────────────
      if (event.method === "agent.tool.started") {
        const toolParams = event.params as { name?: string };
        toolCallCountRef.current += 1;
        setSendState("running");
        if (toolParams.name) {
          setToolName(toolParams.name);
        }
      }
      if (event.method === "agent.tool.delta") {
        const deltaParams = event.params as {
          toolCallId?: string;
          delta?: string;
          type?: string;
          payload?: Record<string, unknown>;
        };
        // Extract progress info from the delta payload.
        // Skill progress events carry { phase, progress, message } or raw delta string.
        const progressPayload =
          deltaParams.payload && typeof deltaParams.payload === "object"
            ? (deltaParams.payload as Record<string, unknown>)
            : undefined;
        const progressMsg =
          typeof progressPayload?.message === "string"
            ? progressPayload.message
            : typeof deltaParams.delta === "string" &&
                deltaParams.delta.length > 0
              ? deltaParams.delta
              : undefined;
        const progressPct =
          typeof progressPayload?.progress === "number"
            ? progressPayload.progress
            : undefined;
        if (progressMsg) {
          setSendState("running");
          setToolName(
            progressPct != null
              ? `${progressMsg} (${progressPct}%)`
              : progressMsg,
          );
        }
      }
      if (
        event.method === "agent.tool.completed" ||
        event.method === "agent.tool.failed"
      ) {
        toolCallCountRef.current = Math.max(0, toolCallCountRef.current - 1);
        if (toolCallCountRef.current === 0) {
          setToolName(null);
        }
      }

      // §5.7: agent.response.started UI handler removed —
      // agent.message.started now handles message lifecycle.

      // ── Message content-block events: live UI state (§Phase 2c+2d) ──
      // Core data mutations (setMessages) are handled by applyAgentEvent()
      // called above, so live + replay share the same reducer.
      // Here we only manage live UI concerns: timers, sendState, status.
      if (event.method === "agent.message.started") {
        const msgParams = event.params as { runId: string };
        markRunActive(msgParams.runId, { sendState: "streaming", status: "thinking" });
      }

      if (event.method === "agent.message.part.started") {
        startResponseTimer();
        setSendState("streaming");
      }

      if (event.method === "agent.message.part.delta") {
        startResponseTimer();
        setSendState("streaming");
      }

      if (event.method === "agent.message.part.updated") {
        setSendState("streaming");
      }

      if (event.method === "agent.message.completed") {
        finishActiveRun({ sendState: "completed" });
      }

      // ── Agent message completed via content-block event ──────────
      // (agent.response.completed UI handler removed — agent.message.completed handles this)
      if (event.method === "agent.run.completed") {
        finishActiveRun({ sendState: "completed" });
      }

      // ── Agent run failed ──────────────────────────────────────
      if (event.method === "agent.run.failed") {
        finishActiveRun({
          sendState: "failed",
          error: event.params.error.message,
        });
      }

      // ── Agent run cancelled ───────────────────────────────────
      if (event.method === "agent.run.cancelled") {
        finishActiveRun({ sendState: "failed" });
        // §Frontend gap: Mark the active assistant message as stopped
        setMessages((items) =>
          items.map((item) =>
            item.role === "assistant" && item.status === "streaming"
              ? { ...item, status: "stopped" as const }
              : item,
          ),
        );
      }

      // ── Agent run interrupted ─────────────────────────────────
      if (event.method === "agent.run.interrupted") {
        finishActiveRun({ sendState: "failed" });
        // §Frontend gap: Mark the active assistant message as stopped
        setMessages((items) =>
          items.map((item) =>
            item.role === "assistant" && item.status === "streaming"
              ? { ...item, status: "stopped" as const }
              : item,
          ),
        );
      }
    });
    return socket;
  }, [
    appendAssistantActivity,
    applyAgentEvent,
    finishActiveRun,
    markRunActive,
    conversationId,
    setConversationId,
    setMessages,
    setPendingState,
    startResponseTimer,
  ]);

  useEffect(() => {
    void refreshApprovals();
  }, [refreshApprovals]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    void (async () => {
      try {
        const replay = await replayConversationEvents(
          requestRef.current,
          conversationId,
          lastSequenceRef.current,
        );
        if (cancelled) return;
        const events = Array.isArray(replay.items) ? replay.items : [];
        for (const event of events) {
          if (seenEventIdsRef.current.has(event.id)) continue;
          applyAgentEvent(event);
        }
      } catch {
        // Best effort replay. Live chat continues even if replay is unavailable.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyAgentEvent, conversationId]);

  const send = useCallback(
    (
      message: string,
      attachments?: AttachmentRef[],
      permissionMode?: "ask" | "auto" | "full",
      modelId?: "dp" | "seed",
    ) => {
      const text = message.trim();
      if (
        (!text && (!attachments || attachments.length === 0)) ||
        pendingRef.current
      )
        return;

      // §5.2: Final gate — validate AttachmentRef[] (not just UploadFile[] UI state).
      // Defense-in-depth: ChatComposer validates at the UploadFile level, but we
      // re-check the final AttachmentRef[] here to catch any edge case where the
      // UploadFile→AttachmentRef conversion drops dataUrl/url/storageKey.
      if (attachments && attachments.length > 0) {
        const refCheck = validateAttachmentRefsForSend(attachments);
        if (refCheck.missingImageRef) {
          setError(
            "图片尚未上传完成，缺少可用的图片链接。请等待上传完成后再试。",
          );
          setSendState("failed");
          return;
        }
      }

      const clientRequestId = `chat_${crypto.randomUUID()}`;
      const localUserMessageId = `local_user_${clientRequestId}`;
      const placeholderId = `local_assistant_${clientRequestId}`;

      setPendingState(true);
      setSendState("sending");
      setStatus("thinking");
      setError("");
      startResponseTimer();

      // ── Immediate UI feedback (architecture doc §12.3) ──────────
      // Append user message AND assistant placeholder synchronously before
      // any network request. The placeholder will be bound to real IDs when
      // agent.run.created and agent.response.started events arrive.
      setMessages((items) => [
        ...items,
        {
          id: localUserMessageId,
          conversationId: conversationId || "pending",
          role: "user" as const,
          content: text,
          createdAt: new Date().toISOString(),
          clientRequestId,
          attachments: attachments?.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            sizeBytes: a.sizeBytes,
            url: a.url,
            dataUrl: a.dataUrl,
            storageKey: a.storageKey,
            provider: a.provider,
            checksum: a.checksum,
          })),
        },
        {
          id: placeholderId,
          conversationId: conversationId || "pending",
          role: "assistant" as const,
          content: "",
          createdAt: new Date().toISOString(),
          status: "pending" as const,
          clientRequestId,
        },
      ]);

      const socket = ensureSocket();
      const transmit = () => {
        setSendState("accepted");
        const requestId = sendChatMessage(socket, {
          ...(conversationId ? { conversationId } : {}),
          message: text,
          mode: "agent",
          permissionMode: permissionMode ?? "auto",
          modelId: modelId ?? "seed",
          clientRequestId,
          attachments,
        });
        // Track the request so we can match the ack response
        pendingAcksRef.current.set(requestId, clientRequestId);
      };
      if (socket.readyState === WebSocket.OPEN) transmit();
      else socket.addEventListener("open", transmit, { once: true });
    },
    [
      conversationId,
      ensureSocket,
      pending,
      setMessages,
      setPendingState,
      startResponseTimer,
    ],
  );

  const stop = useCallback(() => {
    clearResponseTimer();
    const socket = socketRef.current;
    const runId = activeRunIdRef.current;
    activeRunIdRef.current = null;
    if (socket?.readyState === WebSocket.OPEN && runId) {
      sendChatStop(socket, { runId });
    } else {
      closeSocket();
    }
    setPendingState(false);
    setStatus(socket?.readyState === WebSocket.OPEN ? "online" : "offline");
  }, [clearResponseTimer, closeSocket, setPendingState]);

  const approveApproval = useCallback(
    async (approvalId: string) => {
      setApprovals((items) =>
        items.map((item) =>
          item.id === approvalId ? { ...item, status: "approved" } : item,
        ),
      );
      try {
        await approveAgentApproval(requestRef.current, approvalId);
        await refreshApprovals();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        await refreshApprovals();
      }
    },
    [refreshApprovals],
  );

  const rejectApproval = useCallback(
    async (approvalId: string) => {
      setApprovals((items) =>
        items.map((item) =>
          item.id === approvalId ? { ...item, status: "rejected" } : item,
        ),
      );
      try {
        await rejectAgentApproval(requestRef.current, approvalId);
        await refreshApprovals();
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        await refreshApprovals();
      }
    },
    [refreshApprovals],
  );

  const openArtifact = useCallback(async (artifactId: string) => {
    try {
      const artifact = await getAgentArtifact(requestRef.current, artifactId);
      const content = await getAgentArtifactContent(artifactId);
      setSelectedArtifact({ artifact, content });
    } catch {
      setError("Artifact content is not available.");
    }
  }, []);

  const closeArtifact = useCallback(() => {
    setSelectedArtifact(null);
  }, []);

  /**
   * Preconnect the WebSocket without sending any message.
   * Called when user clicks "新对话" so the WS is ready when they type.
   * Does NOT change pending/sendState, does NOT start response timer.
   */
  const preconnect = useCallback(() => {
    ensureSocket();
  }, [ensureSocket]);

  /**
   * Handle rich card interaction actions (toggle_item, submit, open_link).
   * Updates the message's cardStateByCardId so interactive cards
   * (checklist, choice_group, etc.) persist state across re-renders.
   *
   * Phase 1: local state only — no backend event sent.
   * Phase 2 (future): send rich_card.action via WebSocket for submit mode.
   */
  const onCardAction = useCallback(
    (messageId: string, action: RichCardAction) => {
      setMessages((items) =>
        items.map((item) => {
          if (item.id !== messageId) return item;
          const prev = item.cardStateByCardId ?? {};
          const cardId = action.cardId;
          const cardState = (prev[cardId] ?? {}) as Record<string, unknown>;

          let nextCardState: Record<string, unknown>;
          switch (action.type) {
            case "toggle_item": {
              const checkedIds = new Set<string>(
                (cardState.checkedItemIds as string[]) ?? [],
              );
              if (action.checked) {
                checkedIds.add(action.itemId);
              } else {
                checkedIds.delete(action.itemId);
              }
              nextCardState = {
                ...cardState,
                checkedItemIds: Array.from(checkedIds),
              };
              break;
            }
            case "submit": {
              nextCardState = {
                ...cardState,
                submitted: true,
                payload: action.payload,
              };
              break;
            }
            case "open_link": {
              nextCardState = { ...cardState };
              break;
            }
            default: {
              nextCardState = { ...cardState };
            }
          }

          return {
            ...item,
            cardStateByCardId: {
              ...prev,
              [cardId]: nextCardState,
            },
          };
        }),
      );
    },
    [setMessages],
  );

  const chatViewState: ChatViewState = (() => {
    if (error) return "error";
    if (status === "offline" && pending) return "offline";
    if (pending && status === "thinking") return "streaming";
    if (pending) return "loadingConversation";
    return "ready";
  })();

  useEffect(
    () => () => {
      clearResponseTimer();
      closeSocket();
    },
    [clearResponseTimer, closeSocket],
  );

  return {
    send,
    stop,
    preconnect,
    pending,
    status,
    sendState,
    setSendState,
    error,
    setError,
    chatViewState,
    activeRunId,
    toolName,
    approvals,
    artifacts,
    selectedArtifact,
    openArtifact,
    closeArtifact,
    approveApproval,
    rejectApproval,
    onCardAction,
  };
}
