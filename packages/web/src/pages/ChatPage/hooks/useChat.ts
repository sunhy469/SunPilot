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
  sendConversationSubscribe,
  sendConversationUnsubscribe,
} from "../../../features/chat/ws";
import { validateAttachmentRefsForSend } from "../../../features/chat/attachment-utils";
import type {
  AgentActivity,
  ChatMessage,
  AssistantMessagePart,
} from "../../../features/conversations/types";
import type { RichCardAction } from "../../../rich-cards/types";
import type { ChatViewState, LocalSendState } from "../types";

import {
  activityFromAgentEvent,
  assistantMessageReducer,
  findActiveAssistantMessageIndex,
  parseSocketPayload,
  PONG_TIMEOUT_MS,
  RECONNECT_BASE_DELAY,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY,
  type AgentArtifactPreview,
  type AgentArtifactSelection,
  type ChatSocketPayload,
  type JsonRpcResponse,
} from "./chat/chat-state";
export type { AgentArtifactPreview, AgentArtifactSelection } from "./chat/chat-state";

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
  // W6: reconnection backoff + pong-timeout tracking
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const pongTimeoutTimerRef = useRef<number | null>(null);
  // W6: flag to suppress reconnection when closeSocket() is called intentionally
  const intentionalCloseRef = useRef(false);
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
    // W6: cancel any pending reconnect / pong-timeout timers so an
    // intentional close doesn't get undone by a scheduled reconnect.
    intentionalCloseRef.current = true;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pongTimeoutTimerRef.current !== null) {
      window.clearTimeout(pongTimeoutTimerRef.current);
      pongTimeoutTimerRef.current = null;
    }
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
        method === "agent.run.completed"
      ) {
        activeRunIdRef.current = null;
        setActiveRunId(null);
        // §P0: Clear stale errors when a run completes successfully.
        // Prevents "result is correct but page still shows error" mismatch.
        setError?.("");
      }
      if (
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
    [conversationId, setConversationId, setMessages, setError],
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
    // W6: reset the intentional-close flag when opening a new connection
    intentionalCloseRef.current = false;
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
      // W6: connection (re)established — reset the backoff counter and
      // the intentional-close flag (a new connection is not intentional close).
      intentionalCloseRef.current = false;
      reconnectAttemptsRef.current = 0;
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
          // W6: pong timeout — if no pong arrives within PONG_TIMEOUT_MS, the
          // connection is half-open; close it to trigger a reconnect.
          if (pongTimeoutTimerRef.current !== null)
            window.clearTimeout(pongTimeoutTimerRef.current);
          pongTimeoutTimerRef.current = window.setTimeout(() => {
            pongTimeoutTimerRef.current = null;
            if (socket.readyState === WebSocket.OPEN) socket.close();
          }, PONG_TIMEOUT_MS);
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
      // W6: clear the pending pong-timeout timer (no socket to wait on anymore)
      if (pongTimeoutTimerRef.current !== null) {
        window.clearTimeout(pongTimeoutTimerRef.current);
        pongTimeoutTimerRef.current = null;
      }
      if (socketRef.current === socket) socketRef.current = null;
      setStatus("offline");
      setPendingState(false);
      if (wasPending && event.code !== 1000 && event.code !== 4000) {
        setError(event.reason || "WebSocket 连接已断开，请重试。");
      }
      // W6: schedule an automatic reconnect with exponential backoff for
      // non-intentional closures (not code 1000/4000 and not flagged as
      // intentional), up to a max number of tries.
      if (
        !intentionalCloseRef.current &&
        event.code !== 1000 &&
        event.code !== 4000 &&
        reconnectAttemptsRef.current < RECONNECT_MAX_ATTEMPTS
      ) {
        const attempt = reconnectAttemptsRef.current;
        const delay = Math.min(
          RECONNECT_BASE_DELAY * 2 ** attempt,
          RECONNECT_MAX_DELAY,
        );
        reconnectAttemptsRef.current += 1;
        if (reconnectTimerRef.current !== null)
          window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          ensureSocket();
        }, delay);
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

      if (event.method === "pong") {
        // W6: server responded — clear the pong-timeout timer so it doesn't
        // close a healthy connection.
        if (pongTimeoutTimerRef.current !== null) {
          window.clearTimeout(pongTimeoutTimerRef.current);
          pongTimeoutTimerRef.current = null;
        }
        return;
      }

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
    // Reset replay state when switching conversations so events from the
    // new conversation are replayed from scratch.
    seenEventIdsRef.current.clear();
    lastSequenceRef.current = 0;
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

  // §P1-4: Subscribe to conversation events via WebSocket for real-time
  // multi-window support. When conversationId changes, unsubscribe from
  // the old conversation and subscribe to the new one.
  const subscribedConversationRef = useRef<string | null>(null);
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const prev = subscribedConversationRef.current;
    if (prev && prev !== conversationId) {
      sendConversationUnsubscribe(socket, prev);
    }

    if (conversationId && conversationId !== prev) {
      sendConversationSubscribe(socket, conversationId, lastSequenceRef.current);
      subscribedConversationRef.current = conversationId;
    }

    return () => {
      if (subscribedConversationRef.current) {
        const s = socketRef.current;
        if (s && s.readyState === WebSocket.OPEN) {
          sendConversationUnsubscribe(s, subscribedConversationRef.current);
        }
        subscribedConversationRef.current = null;
      }
    };
  }, [conversationId]);

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
          modelId,
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
