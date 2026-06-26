import { Drawer, Input, Button, List } from "antd";
import { useState, useEffect, useRef, useCallback } from "react";
import type { createRequest } from "../../../shared/api/client";
import { createTask, listActionLogs } from "../api";
import { useIsMobile } from "../hooks/useIsMobile";
import { useDigitalWorldSocket } from "../hooks/useDigitalWorldBootstrap";
import "./BeingChatPanel.scss";

type Request = ReturnType<typeof createRequest>;

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface BeingChatPanelProps {
  open: boolean;
  beingId?: string;
  beingName?: string;
  request: Request;
  onClose: () => void;
}

/** §9.4.3: event-driven polling cadence. After sending a message we poll
 *  immediately, then every POLL_INTERVAL_MS for up to MAX_POLLS iterations
 *  (≈10s total) before giving up. The WebSocket subscription can trigger an
 *  immediate poll at any time, short-circuiting this window. */
const POLL_INTERVAL_MS = 500;
const MAX_POLLS = 20;

// Task 12 (§9.4.3): quick command shortcuts shown above the input.
const QUICK_COMMANDS: { label: string; text: string }[] = [
  { label: "今天做了什么", text: "今天做了什么？" },
  { label: "查看产物", text: "查看产物" },
];

export function BeingChatPanel({
  open,
  beingId,
  beingName,
  request,
  onClose,
}: BeingChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  // Task 17 (§9.4.5): full-screen Drawer on mobile (<768px).
  const isMobile = useIsMobile();
  // W2: track pending timers so they can be cleared on unmount.
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track the latest action log timestamp we've seen to avoid showing old data.
  const lastActionLogIdRef = useRef<string | null>(null);
  const pollCountRef = useRef(0);
  // §9.4.3: shared WebSocket for realtime being action / world state events.
  const { subscribe } = useDigitalWorldSocket();

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // Cleanup all timers on unmount.
  useEffect(() => {
    return () => {
      if (replyTimerRef.current !== null) {
        clearTimeout(replyTimerRef.current);
        replyTimerRef.current = null;
      }
      stopPolling();
    };
  }, [stopPolling]);

  // Stop polling when panel closes.
  useEffect(() => {
    if (!open) {
      stopPolling();
      setLoading(false);
    }
  }, [open, stopPolling]);

  // §9.4.3: seed the last-seen action log id when the panel opens so only
  // NEW chat.message logs (created after opening) are appended as responses.
  // Without this, the first poll after sending would re-append every
  // historical chat.message log.
  useEffect(() => {
    if (!open || !beingId) return;
    lastActionLogIdRef.current = null;
    pollCountRef.current = 0;
    void listActionLogs(request, beingId)
      .then((logs) => {
        const arr = logs as Array<{ id: string; eventType: string }>;
        // Prefer the latest chat.message log id; fall back to the latest log
        // id overall so older logs are never re-processed.
        let seedId: string | null = null;
        for (let i = arr.length - 1; i >= 0; i--) {
          const log = arr[i]!;
          if (log.eventType === "chat.message") {
            seedId = log.id;
            break;
          }
        }
        if (!seedId && arr.length > 0) {
          seedId = arr[arr.length - 1]!.id;
        }
        lastActionLogIdRef.current = seedId;
      })
      .catch(() => {});
  }, [open, beingId, request]);

  // §9.4.3: poll the action logs for new chat.message entries and append them
  // as assistant messages. Returns true if a response was received.
  const pollForResponses = useCallback(async (): Promise<boolean> => {
    if (!beingId) return false;
    try {
      const logs = (await listActionLogs(request, beingId)) as Array<{
        id: string;
        eventType: string;
        payload: Record<string, unknown>;
        createdAt: string;
      }>;
      const lastSeenId = lastActionLogIdRef.current;
      const lastSeenLog = lastSeenId
        ? logs.find((l) => l.id === lastSeenId)
        : undefined;
      const lastSeenAt = lastSeenLog?.createdAt ?? "";
      const newLogs = logs.filter(
        (log) =>
          log.eventType === "chat.message" &&
          log.id !== lastSeenId &&
          log.createdAt > lastSeenAt,
      );
      if (newLogs.length === 0) return false;
      lastActionLogIdRef.current = newLogs[newLogs.length - 1]!.id;
      for (const log of newLogs) {
        const content =
          (log.payload.message as string) ??
          (log.payload.content as string) ??
          JSON.stringify(log.payload);
        const assistantMsg: ChatMessage = {
          id: `msg_${log.id}`,
          role: "assistant",
          content,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      }
      return true;
    } catch {
      // Poll errors are expected (e.g. network blip); don't surface to user.
      return false;
    }
  }, [beingId, request]);

  // §9.4.3: start the event-driven polling window. Polls immediately, then
  // every POLL_INTERVAL_MS for up to MAX_POLLS iterations. The typing
  // indicator is cleared when a response arrives or the window expires.
  const startEventDrivenPolling = useCallback(() => {
    stopPolling();
    pollCountRef.current = 0;
    // Immediate poll (the being may have already responded by the time the
    // task creation ack returns).
    void pollForResponses().then((received) => {
      if (received) {
        setLoading(false);
        return;
      }
    });
    pollTimerRef.current = setInterval(() => {
      pollCountRef.current++;
      void pollForResponses().then((received) => {
        if (received) {
          stopPolling();
          setLoading(false);
        }
      });
      if (pollCountRef.current >= MAX_POLLS) {
        stopPolling();
        // No response within the window — stop showing the typing indicator.
        setLoading(false);
      }
    }, POLL_INTERVAL_MS);
  }, [pollForResponses, stopPolling]);

  // §9.4.3: WebSocket subscription — when a relevant realtime event arrives
  // (world state change, being action log, or agent message completion),
  // trigger an immediate poll for chat responses. This provides instant
  // delivery when the backend emits events, short-circuiting the polling
  // window. Falls back to the event-driven polling above when no WS events
  // arrive.
  useEffect(() => {
    if (!open || !beingId) return;
    return subscribe((message) => {
      const msg = message as { method?: string };
      if (!msg || !msg.method) return;
      if (
        msg.method === "world.state.changed" ||
        msg.method === "being.action.logged" ||
        msg.method === "agent.message.completed"
      ) {
        // Only act while we're waiting for a response.
        if (!loading) return;
        void pollForResponses().then((received) => {
          if (received) {
            stopPolling();
            setLoading(false);
          }
        });
      }
    });
  }, [open, beingId, subscribe, loading, pollForResponses, stopPolling]);

  // Task 12: send arbitrary text without depending on closure `input`.
  // Shared by the input send button, Enter key, and quick command buttons.
  const sendText = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !beingId) return;

      const userMsg: ChatMessage = {
        id: `msg_${Date.now()}`,
        role: "user",
        content: trimmed,
      };
      setMessages((prev) => [...prev, userMsg]);
      setInput("");
      setLoading(true);

      try {
        // W2: send message via createTask API instead of mock.
        await createTask(request, beingId, {
          type: "chat",
          title: trimmed.slice(0, 100),
          input: { message: trimmed },
        });
        // §9.4.3: start the event-driven polling window. The WebSocket
        // subscription (above) can trigger an immediate poll that
        // short-circuits this window when a realtime event arrives.
        startEventDrivenPolling();
      } catch (err) {
        setLoading(false);
        const errorMsg: ChatMessage = {
          id: `msg_${Date.now()}_err`,
          role: "assistant",
          content: `发送失败：${err instanceof Error ? err.message : "未知错误"}`,
        };
        setMessages((prev) => [...prev, errorMsg]);
      }
    },
    [beingId, request, startEventDrivenPolling],
  );

  const handleSend = useCallback(() => {
    void sendText(input);
  }, [input, sendText]);

  return (
    <Drawer
      title={`与 ${beingName ?? "数字生命"} 对话`}
      open={open}
      onClose={onClose}
      width={isMobile ? "100%" : 360}
    >
      <div className="being-chat-panel">
        <div className="being-chat-panel__messages">
          {messages.length === 0 && !loading && (
            <div className="being-chat-panel__empty">发送消息与数字生命对话</div>
          )}
          <List
            dataSource={messages}
            renderItem={(msg) => (
              <div
                className={`being-chat-panel__msg being-chat-panel__msg--${msg.role}`}
              >
                {msg.content}
              </div>
            )}
          />
          {loading && (
            // Task 12 (§9.4.3): "typing..." indicator with animated dots.
            <div className="being-chat-panel__typing">
              <span className="being-chat-panel__typing-text">正在输入</span>
              <span className="being-chat-panel__typing-dots">
                <span className="being-chat-panel__typing-dot" />
                <span className="being-chat-panel__typing-dot" />
                <span className="being-chat-panel__typing-dot" />
              </span>
            </div>
          )}
        </div>
        {/* Task 12 (§9.4.3): quick command buttons row */}
        <div className="being-chat-panel__quick-commands">
          {QUICK_COMMANDS.map((cmd) => (
            <Button
              key={cmd.label}
              size="small"
              disabled={!beingId || loading}
              onClick={() => { void sendText(cmd.text); }}
            >
              {cmd.label}
            </Button>
          ))}
        </div>
        <div className="being-chat-panel__input">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={() => { void handleSend(); }}
            placeholder="输入消息..."
            disabled={!beingId || loading}
          />
          <Button
            type="primary"
            onClick={() => { void handleSend(); }}
            disabled={!beingId || loading}
          >
            发送
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
