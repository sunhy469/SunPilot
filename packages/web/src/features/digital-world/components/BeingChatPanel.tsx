import { Drawer, Input, Button, List, Spin } from "antd";
import { useState, useEffect, useRef, useCallback } from "react";
import type { createRequest } from "../../../shared/api/client";
import { createTask, listActionLogs } from "../api";
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

/** Polling interval for being responses (ms). */
const POLL_INTERVAL_MS = 2000;

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
  // W2: track pending timers so they can be cleared on unmount.
  const replyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track the latest action log timestamp we've seen to avoid showing old data.
  const lastActionLogIdRef = useRef<string | null>(null);

  // Cleanup all timers on unmount.
  useEffect(() => {
    return () => {
      if (replyTimerRef.current !== null) {
        clearTimeout(replyTimerRef.current);
        replyTimerRef.current = null;
      }
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, []);

  // Stop polling when panel closes.
  useEffect(() => {
    if (!open) {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      setLoading(false);
    }
  }, [open]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !beingId) return;

    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      // W2: send message via createTask API instead of mock.
      await createTask(request, beingId, {
        type: "chat",
        title: text.slice(0, 100),
        input: { message: text },
      });

      // Start polling for the being's response via action logs.
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
      }
      pollTimerRef.current = setInterval(async () => {
        try {
          const logs = (await listActionLogs(request, beingId)) as Array<{
            id: string;
            eventType: string;
            payload: Record<string, unknown>;
            createdAt: string;
          }>;
          // Find new chat messages from the being since our last check.
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
          if (newLogs.length > 0) {
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
            // Stop polling once we have a response.
            if (pollTimerRef.current !== null) {
              clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
            setLoading(false);
          }
        } catch {
          // Poll errors are expected (e.g. network blip); don't surface to user.
        }
      }, POLL_INTERVAL_MS);
    } catch (err) {
      setLoading(false);
      const errorMsg: ChatMessage = {
        id: `msg_${Date.now()}_err`,
        role: "assistant",
        content: `发送失败：${err instanceof Error ? err.message : "未知错误"}`,
      };
      setMessages((prev) => [...prev, errorMsg]);
    }
  }, [input, beingId, request]);

  return (
    <Drawer
      title={`与 ${beingName ?? "数字生命"} 对话`}
      open={open}
      onClose={onClose}
      width={360}
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
            <div className="being-chat-panel__loading">
              <Spin size="small" /> 等待回复中...
            </div>
          )}
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
