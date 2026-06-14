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
  ChatSocketErrorResponse,
  ChatSocketEvent,
} from "../../../features/chat/types";
import {
  chatSocketUrl,
  createChatSocket,
  sendChatMessage,
  sendChatStop,
} from "../../../features/chat/ws";
import type { ChatMessage } from "../../../features/conversations/types";
import type { ChatViewState } from "../types";

type ChatSocketPayload = ChatSocketEvent | ChatSocketErrorResponse;

export interface AgentTimelineItem {
  id: string;
  runId?: string;
  conversationId?: string;
  type: string;
  title: string;
  detail?: string;
  tone: "neutral" | "working" | "success" | "warning" | "danger";
  createdAt: string;
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

export function useChat(
  conversationId: string,
  setConversationId: (id: string) => void,
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"online" | "offline" | "thinking">(
    "offline",
  );
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const responseTimerRef = useRef<number | null>(null);
  const keepAliveTimerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const activeRunIdRef = useRef<string | null>(null);
  const requestRef = useRef(createRequest());
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [timeline, setTimeline] = useState<AgentTimelineItem[]>([]);
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
      const item = timelineItemFromEvent(event);
      if (item) {
        setTimeline((items) => {
          if (items.some((existing) => existing.id === item.id)) return items;
          return [...items, item].slice(-12);
        });
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
      }
      if (
        method === "agent.run.completed" ||
        method === "agent.run.failed" ||
        method === "agent.run.cancelled" ||
        method === "agent.run.interrupted"
      ) {
        activeRunIdRef.current = null;
      }
    },
    [],
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
        applyAgentEvent(payload);
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

      if (payload.method === "agent.run.created") {
        activeRunIdRef.current = payload.params.runId;
        setConversationId(payload.params.conversationId);
        setStatus("thinking");
        setMessages((items) =>
          items.map((item) =>
            item.conversationId === "pending"
              ? { ...item, conversationId: payload.params.conversationId }
              : item,
          ),
        );
      }

      if (payload.method === "agent.response.started") {
        activeRunIdRef.current = payload.params.runId;
        setStatus("thinking");
        setMessages((items) => {
          if (items.some((item) => item.id === payload.params.messageId)) {
            return items;
          }
          return [
            ...items,
            {
              id: payload.params.messageId,
              conversationId: payload.params.conversationId ?? conversationId,
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString(),
            },
          ];
        });
      }

      // ── Agent response delta ──────────────────────────────────
      const deltaPayload =
        payload.method === "agent.response.delta"
          ? {
              conversationId: payload.params.conversationId,
              messageId: payload.params.messageId,
              delta: payload.params.delta,
            }
          : null;

      if (deltaPayload) {
        startResponseTimer();
        activeRunIdRef.current = payload.params.runId;
        setMessages((items) => {
          const exists = items.some(
            (item) => item.id === deltaPayload.messageId,
          );
          if (!exists) {
            // Auto-create assistant message if this is the first delta
            return [
              ...items,
              {
                id: deltaPayload.messageId,
                conversationId: deltaPayload.conversationId,
                role: "assistant",
                content: deltaPayload.delta,
                createdAt: new Date().toISOString(),
              },
            ];
          }
          return items.map((item) =>
            item.id === deltaPayload.messageId
              ? { ...item, content: item.content + deltaPayload.delta }
              : item,
          );
        });
      }

      // ── Agent response completed ──────────────────────────────
      if (payload.method === "agent.response.completed") {
        clearResponseTimer();
        setStatus("online");
        setPendingState(false);
        activeRunIdRef.current = null;
      }

      // ── Agent run completed ───────────────────────────────────
      if (payload.method === "agent.run.completed") {
        clearResponseTimer();
        setStatus("online");
        setPendingState(false);
        activeRunIdRef.current = null;
      }

      // ── Agent run failed ──────────────────────────────────────
      if (payload.method === "agent.run.failed") {
        clearResponseTimer();
        setStatus("online");
        setPendingState(false);
        setError(payload.params.error.message);
        activeRunIdRef.current = null;
      }

      // ── Agent run cancelled ───────────────────────────────────
      if (payload.method === "agent.run.cancelled") {
        clearResponseTimer();
        setStatus("online");
        setPendingState(false);
        activeRunIdRef.current = null;
      }

      // ── Agent run interrupted ─────────────────────────────────
      if (payload.method === "agent.run.interrupted") {
        clearResponseTimer();
        setStatus("online");
        setPendingState(false);
        activeRunIdRef.current = null;
      }
    });
    return socket;
  }, [
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
    (message: string) => {
      const text = message.trim();
      if (!text || pending) return;
      setPendingState(true);
      setStatus("thinking");
      setError("");
      startResponseTimer();
      setMessages((items) => [
        ...items,
        {
          id: `local_${crypto.randomUUID()}`,
          conversationId: conversationId || "pending",
          role: "user",
          content: text,
          createdAt: new Date().toISOString(),
        },
      ]);
      const socket = ensureSocket();
      const transmit = () =>
        sendChatMessage(socket, {
          ...(conversationId ? { conversationId } : {}),
          message: text,
        });
      if (socket.readyState === WebSocket.OPEN) transmit();
      else socket.addEventListener("open", transmit, { once: true });
    },
    [
      conversationId,
      ensureSocket,
      pending,
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
    error,
    setError,
    chatViewState,
    approvals,
    timeline,
    artifacts,
    selectedArtifact,
    openArtifact,
    closeArtifact,
    approveApproval,
    rejectApproval,
  };
}

function timelineItemFromEvent(
  event: ChatSocketEvent | AgentEventRecord,
): AgentTimelineItem | undefined {
  const method = "method" in event ? event.method : event.type;
  if (
    method === "pong" ||
    method === "agent.response.delta" ||
    method === "agent.run.created" ||
    method === "agent.run.completed" ||
    method === "agent.context.started" ||
    method === "agent.context.completed" ||
    method === "agent.intent.detected"
  )
    return undefined;
  const params = ("method" in event ? event.params : event.payload) as Record<
    string,
    unknown
  >;
  const id =
    "id" in event && event.id
      ? event.id
      : `${method}:${String(params.runId ?? "")}:${String(params.toolCallId ?? params.approvalId ?? params.memoryId ?? params.artifactId ?? "")}`;
  const base = {
    id,
    runId:
      ("runId" in event && event.runId) || typeof params.runId === "string"
        ? (("runId" in event ? event.runId : params.runId) as string)
        : undefined,
    conversationId:
      ("conversationId" in event && event.conversationId) ||
      typeof params.conversationId === "string"
        ? (("conversationId" in event
            ? event.conversationId
            : params.conversationId) as string)
        : undefined,
    type: method,
    createdAt:
      ("createdAt" in event && event.createdAt) || new Date().toISOString(),
  };

  switch (method) {
    // run.created, context.*, intent.detected — filtered above
    // (internal lifecycle events, not surfaced to the timeline)
    case "agent.plan.created": {
      const plan = params.plan as
        | { summary?: unknown; steps?: unknown }
        | undefined;
      return {
        ...base,
        title: "Plan created",
        detail:
          typeof plan?.summary === "string"
            ? plan.summary
            : typeof plan?.steps === "number"
              ? `${plan.steps} steps`
              : undefined,
        tone: "neutral",
      };
    }
    case "agent.tool.selected":
      return {
        ...base,
        title: `Tool selected: ${String(params.name ?? params.skillId ?? "tool")}`,
        detail:
          typeof params.riskLevel === "string"
            ? `risk ${params.riskLevel}`
            : undefined,
        tone: "working",
      };
    case "agent.tool.started":
      return {
        ...base,
        title: `Tool started: ${String(params.name ?? params.skillId ?? "tool")}`,
        tone: "working",
      };
    case "agent.tool.delta":
      return {
        ...base,
        title: `Tool update: ${String(params.toolCallId ?? "tool")}`,
        detail: typeof params.delta === "string" ? params.delta : undefined,
        tone: "working",
      };
    case "agent.tool.completed":
      return {
        ...base,
        title: `Tool completed: ${String(params.skillId ?? "tool")}`,
        detail: typeof params.summary === "string" ? params.summary : undefined,
        tone: "success",
      };
    case "agent.tool.failed": {
      const error = params.error as { message?: unknown } | undefined;
      return {
        ...base,
        title: `Tool failed: ${String(params.skillId ?? "tool")}`,
        detail: typeof error?.message === "string" ? error.message : undefined,
        tone: "danger",
      };
    }
    case "agent.approval.required":
      return {
        ...base,
        title: `Approval required: ${String(params.title ?? "Action")}`,
        detail:
          typeof params.riskLevel === "string"
            ? `risk ${params.riskLevel}`
            : undefined,
        tone: "warning",
      };
    case "agent.approval.approved":
      return { ...base, title: "Approval approved", tone: "success" };
    case "agent.approval.rejected":
      return { ...base, title: "Approval rejected", tone: "danger" };
    case "agent.approval.expired":
      return {
        ...base,
        title: "Approval expired",
        detail:
          typeof params.title === "string"
            ? params.title
            : typeof params.approvalId === "string"
              ? params.approvalId
              : undefined,
        tone: "warning",
      };
    case "agent.clarification.requested":
      return {
        ...base,
        title: "Clarification requested",
        detail:
          typeof params.question === "string" ? params.question : undefined,
        tone: "warning",
      };
    case "agent.artifact.created":
      return {
        ...base,
        title: `Artifact: ${String(params.name ?? params.artifactId ?? "created")}`,
        detail: typeof params.type === "string" ? params.type : undefined,
        tone: "success",
      };
    case "agent.memory.written":
      return {
        ...base,
        title: `Memory written: ${String(params.type ?? "memory")}`,
        detail: typeof params.scope === "string" ? params.scope : undefined,
        tone: "success",
      };
    // run.completed — filtered above
    case "agent.run.failed": {
      const error = params.error as { message?: unknown } | undefined;
      return {
        ...base,
        title: "Run failed",
        detail: typeof error?.message === "string" ? error.message : undefined,
        tone: "danger",
      };
    }
    case "agent.run.cancelled":
      return { ...base, title: "Run cancelled", tone: "warning" };
    case "agent.run.interrupted":
      return {
        ...base,
        title: "Run interrupted",
        detail: typeof params.reason === "string" ? params.reason : undefined,
        tone: "warning",
      };
    case "agent.error":
      return {
        ...base,
        title: "Agent error",
        detail: typeof params.message === "string" ? params.message : undefined,
        tone: "danger",
      };
    default:
      return undefined;
  }
}
