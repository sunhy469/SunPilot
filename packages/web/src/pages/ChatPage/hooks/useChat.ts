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
} from "../../../features/conversations/types";
import type { ChatViewState, LocalSendState } from "../types";

type ChatSocketPayload = ChatSocketEvent | ChatSocketErrorResponse;

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

function parseSocketPayload(data: string): ChatSocketPayload | undefined {
  const payload = JSON.parse(data) as Partial<ChatSocketPayload> | undefined;
  if (!payload || typeof payload !== "object") return undefined;
  if ("error" in payload && typeof payload.error?.message === "string") {
    return { error: { message: payload.error.message } };
  }
  if ("method" in payload) {
    switch (payload.method) {
      case "agent.run.created":
      case "agent.context.started":
      case "agent.context.completed":
      case "agent.intent.detected":
      case "agent.plan.created":
      case "agent.response.started":
      case "agent.response.delta":
      case "agent.response.completed":
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
 * Map agent events to user-visible activities.
 *
 * Internal lifecycle events (context, intent, plan, model lifecycle)
 * are intentionally NOT mapped to activities — they are debug/trace
 * information, not user-facing content. The debug panel shows full
 * event traces separately.
 *
 * Phase 0 of content-block streaming refactoring:
 *   https://github.com/sunhy469/SunPilot/blob/main/developer_docs/guides/
 *   agent_interleaved_streaming_response_design.md
 */
function activityFromAgentEvent(
  event: ChatSocketEvent,
): AgentActivity | undefined {
  if (event.method === "pong") return undefined;
  const createdAt = event.createdAt ?? new Date().toISOString();
  const id = event.id ?? `${event.method}_${createdAt}`;

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

    // ── Internal lifecycle events — intentionally hidden ──────
    // agent.context.started    → debug only
    // agent.context.completed  → debug only
    // agent.intent.detected    → debug only
    // agent.plan.created       → debug only
    // agent.tool.selected      → debug only
    // agent.model.started      → debug only
    // agent.model.completed    → debug only
    // agent.model.failed       → debug only
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
        const payload = params as { approvalId: string; decidedBy?: string };
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
      if (
        method === "agent.run.completed" ||
        method === "agent.run.failed" ||
        method === "agent.run.cancelled" ||
        method === "agent.run.interrupted"
      ) {
        activeRunIdRef.current = null;
        setActiveRunId(null);
      }

      // ── Message content-block events (§Phase 2d: unified reducer) ──
      // These are applied here so both live WebSocket events AND
      // replayConversationEvents() results update message parts.
      // The live path also triggers startResponseTimer/setSendState
      // in the WebSocket message handler, but the core state mutation
      // (setMessages) lives here for both paths.
      if (method === "agent.message.started") {
        const msgParams = params as {
          runId: string;
          conversationId: string;
          messageId: string;
        };
        setMessages((items) => {
          const placeholderIdx = items.findIndex(
            (item) => item.role === "assistant" && item.status === "pending",
          );
          if (placeholderIdx >= 0) {
            return items.map((item, idx) =>
              idx === placeholderIdx
                ? {
                    ...item,
                    id: msgParams.messageId,
                    conversationId: msgParams.conversationId ?? conversationId,
                    status: "streaming" as const,
                    parts: [],
                  }
                : item,
            );
          }
          if (items.some((item) => item.id === msgParams.messageId)) {
            return items;
          }
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
              parts: [],
            },
          ];
        });
        return;
      }

      if (method === "agent.message.part.started") {
        const partParams = params as {
          messageId: string;
          part: Record<string, unknown>;
        };
        setMessages((items) =>
          items.map((item) =>
            item.id === partParams.messageId
              ? {
                  ...item,
                  parts: [
                    ...(item.parts ?? []),
                    partParams.part as ChatMessage["parts"] extends Array<infer T> ? T : never,
                  ],
                }
              : item,
          ),
        );
        return;
      }

      if (method === "agent.message.part.delta") {
        const deltaParams = params as {
          conversationId?: string;
          messageId: string;
          partId: string;
          delta: string;
        };
        setMessages((items) =>
          upsertTextPartDelta(items, {
            conversationId: deltaParams.conversationId ?? conversationId,
            messageId: deltaParams.messageId,
            partId: deltaParams.partId,
            delta: deltaParams.delta,
          }),
        );
        return;
      }

      if (method === "agent.message.part.updated") {
        const updateParams = params as {
          messageId: string;
          partId: string;
          patch: Record<string, unknown>;
        };
        setMessages((items) =>
          items.map((item) =>
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
          ),
        );
        return;
      }

      if (method === "agent.message.completed") {
        const completedParams = params as {
          runId?: string;
          conversationId?: string;
          messageId: string;
          content: string;
          parts: Array<Record<string, unknown>>;
          cards?: Array<{ type: string; title?: string; data: Record<string, unknown> }>;
        };
        setMessages((items) =>
          items.map((item) =>
            item.id === completedParams.messageId
              ? {
                  ...item,
                  content: completedParams.content,
                  parts: completedParams.parts as unknown as ChatMessage["parts"],
                  status: "completed" as const,
                  cards: (completedParams.cards as ChatMessage["cards"]) ?? item.cards,
                }
              : item,
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
      let payload: ChatSocketPayload | undefined;
      try {
        payload = parseSocketPayload(String(raw.data));
      } catch {
        return;
      }
      if (!payload) return;
      if ("error" in payload) {
        clearResponseTimer();
        setError(payload.error.message);
        setPendingState(false);
        setStatus("online");
        return;
      }
      // ── Agent error events ────────────────────────────────────
      if (payload.method === "agent.error") {
        clearResponseTimer();
        setSendState("failed");
        applyAgentEvent(payload);
        const activity = activityFromAgentEvent(payload);
        if (activity) {
          appendAssistantActivity(activity);
        }
        setError(
          payload.params.error?.message ??
            payload.params.message ??
            "Agent request failed.",
        );
        setPendingState(false);
        setStatus("online");
        return;
      }

      if (payload.method === "pong") return;

      applyAgentEvent(payload);
      const activity = activityFromAgentEvent(payload);
      if (activity) {
        appendAssistantActivity(activity);
      }

      if (payload.method === "agent.run.created") {
        activeRunIdRef.current = payload.params.runId ?? null;
        setActiveRunId(payload.params.runId);
        setConversationId(payload.params.conversationId);
        setSendState("running");
        setStatus("thinking");
        // Replace "pending" conversationId on all local messages with the real one
        setMessages((items) =>
          items.map((item) =>
            item.conversationId === "pending"
              ? { ...item, conversationId: payload.params.conversationId }
              : item,
          ),
        );
      }

      // ── Tool call tracking ──────────────────────────────────
      if (payload.method === "agent.tool.started") {
        const toolParams = payload.params as { name?: string };
        toolCallCountRef.current += 1;
        setSendState("running");
        if (toolParams.name) {
          setToolName(toolParams.name);
        }
      }
      if (payload.method === "agent.tool.delta") {
        const deltaParams = payload.params as {
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
        payload.method === "agent.tool.completed" ||
        payload.method === "agent.tool.failed"
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
      if (payload.method === "agent.message.started") {
        const msgParams = payload.params as { runId: string };
        activeRunIdRef.current = msgParams.runId;
        setActiveRunId(msgParams.runId);
        setSendState("streaming");
        setStatus("thinking");
      }

      if (payload.method === "agent.message.part.started") {
        startResponseTimer();
        setSendState("streaming");
      }

      if (payload.method === "agent.message.part.delta") {
        startResponseTimer();
        setSendState("streaming");
      }

      if (payload.method === "agent.message.part.updated") {
        setSendState("streaming");
      }

      if (payload.method === "agent.message.completed") {
        clearResponseTimer();
        setSendState("completed");
        setStatus("online");
        setPendingState(false);
        setToolName(null);
        toolCallCountRef.current = 0;
        activeRunIdRef.current = null;
        setActiveRunId(null);
      }

      // ── Agent message completed via content-block event ──────────
      // (agent.response.completed UI handler removed — agent.message.completed handles this)
      if (payload.method === "agent.run.completed") {
        clearResponseTimer();
        setSendState("completed");
        setStatus("online");
        setPendingState(false);
        setToolName(null);
        toolCallCountRef.current = 0;
        activeRunIdRef.current = null;
        setActiveRunId(null);
      }

      // ── Agent run failed ──────────────────────────────────────
      if (payload.method === "agent.run.failed") {
        clearResponseTimer();
        setSendState("failed");
        setStatus("online");
        setPendingState(false);
        setError(payload.params.error.message);
        setToolName(null);
        toolCallCountRef.current = 0;
        activeRunIdRef.current = null;
        setActiveRunId(null);
      }

      // ── Agent run cancelled ───────────────────────────────────
      if (payload.method === "agent.run.cancelled") {
        clearResponseTimer();
        setSendState("failed");
        setStatus("online");
        setPendingState(false);
        setToolName(null);
        toolCallCountRef.current = 0;
        activeRunIdRef.current = null;
        setActiveRunId(null);
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
      if (payload.method === "agent.run.interrupted") {
        clearResponseTimer();
        setSendState("failed");
        setStatus("online");
        setPendingState(false);
        setToolName(null);
        toolCallCountRef.current = 0;
        activeRunIdRef.current = null;
        setActiveRunId(null);
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
    clearResponseTimer,
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
      if ((!text && (!attachments || attachments.length === 0)) || pending)
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

      const placeholderId = `local_${crypto.randomUUID()}`;

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
          id: `local_${crypto.randomUUID()}`,
          conversationId: conversationId || "pending",
          role: "user" as const,
          content: text,
          createdAt: new Date().toISOString(),
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
        },
      ]);

      const socket = ensureSocket();
      const transmit = () => {
        setSendState("accepted");
        sendChatMessage(socket, {
          ...(conversationId ? { conversationId } : {}),
          message: text,
          mode: "agent",
          permissionMode: permissionMode ?? "auto",
          modelId: modelId ?? "seed",
          attachments,
        });
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
  };
}
