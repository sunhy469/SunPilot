import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { ChatSocketErrorResponse, ChatSocketEvent } from "../../../features/chat/types";
import { chatSocketUrl, createChatSocket, sendChatMessage, sendChatStop } from "../../../features/chat/ws";
import type { ChatMessage } from "../../../features/conversations/types";
import type { ChatViewState } from "../types";

type ChatSocketPayload = ChatSocketEvent | ChatSocketErrorResponse;

function parseSocketPayload(data: string): ChatSocketPayload | undefined {
  const payload = JSON.parse(data) as Partial<ChatSocketPayload> | undefined;
  if (!payload || typeof payload !== "object") return undefined;
  if ("error" in payload && typeof payload.error?.message === "string") {
    return { error: { message: payload.error.message } };
  }
  if ("method" in payload) {
    switch (payload.method) {
      case "chat.message.created":
      case "chat.assistant.started":
      case "chat.assistant.delta":
      case "chat.assistant.completed":
      case "chat.error":
      case "pong":
        return payload as ChatSocketEvent;
      default:
        return undefined;
    }
  }
  return undefined;
}

export function useChat(
  conversationId: string,
  setConversationId: (id: string) => void,
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"online" | "offline" | "thinking">("offline");
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const responseTimerRef = useRef<number | null>(null);
  const keepAliveTimerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);

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
      setStatus(socketRef.current?.readyState === WebSocket.OPEN ? "online" : "offline");
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

  const ensureSocket = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return socketRef.current;
    const socket = createChatSocket();
    socketRef.current = socket;
    const openTimer = window.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.close();
        setPendingState(false);
        setStatus("offline");
        setError(`无法连接到 daemon WebSocket：${chatSocketUrl()}。请确认页面地址和后端代理配置一致。`);
      }
    }, 10_000);
    socket.addEventListener("open", () => {
      window.clearTimeout(openTimer);
      setStatus((current) => (current === "thinking" ? "thinking" : "online"));
      setError("");
      if (keepAliveTimerRef.current !== null) window.clearInterval(keepAliveTimerRef.current);
      keepAliveTimerRef.current = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "ping", params: {} }));
        }
      }, 25_000);
    });
    socket.addEventListener("error", () => {
      const wasPending = pendingRef.current;
      window.clearTimeout(openTimer);
      clearResponseTimer();
      setPendingState(false);
      setStatus("offline");
      if (wasPending) setError(`WebSocket 连接失败：${chatSocketUrl()}。请在 Network 里查看 v1/ws 的状态码。`);
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
      if (payload.error) {
        clearResponseTimer();
        setError(payload.error.message);
        setPendingState(false);
        setStatus("online");
        return;
      }
      if (payload.method === "chat.error") {
        clearResponseTimer();
        setError(payload.params.error.message);
        setPendingState(false);
        setStatus("online");
        return;
      }
      if (payload.method === "pong") return;
      if (payload.method === "chat.message.created") {
        setConversationId(payload.params.conversationId);
        setMessages((items) => [
          ...items.filter((item) => item.id !== payload.params.message.id),
          payload.params.message,
        ]);
      }
      if (payload.method === "chat.assistant.started") {
        setStatus("thinking");
        setMessages((items) => [
          ...items,
          {
            id: payload.params.messageId,
            conversationId: payload.params.conversationId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      if (payload.method === "chat.assistant.delta") {
        startResponseTimer();
        setMessages((items) =>
          items.map((item) =>
            item.id === payload.params.messageId
              ? { ...item, content: item.content + payload.params.delta }
              : item,
          ),
        );
      }
      if (payload.method === "chat.assistant.completed") {
        clearResponseTimer();
        setStatus("online");
        setPendingState(false);
        setMessages((items) =>
          items.map((item) =>
            item.id === payload.params.message.id ? payload.params.message : item,
          ),
        );
      }
    });
    return socket;
  }, [clearResponseTimer, setConversationId, setMessages, setPendingState, startResponseTimer]);

  const send = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text || pending) return;
      setPendingState(true);
      setStatus("thinking");
      setError("");
      startResponseTimer();
      const socket = ensureSocket();
      const transmit = () =>
        sendChatMessage(socket, {
          ...(conversationId ? { conversationId } : {}),
          message: text,
        });
      if (socket.readyState === WebSocket.OPEN) transmit();
      else socket.addEventListener("open", transmit, { once: true });
    },
    [conversationId, ensureSocket, pending, setPendingState, startResponseTimer],
  );

  const stop = useCallback(() => {
    clearResponseTimer();
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) {
      sendChatStop(socket);
    } else {
      closeSocket();
    }
    setPendingState(false);
    setStatus(socket?.readyState === WebSocket.OPEN ? "online" : "offline");
  }, [clearResponseTimer, closeSocket, setPendingState]);

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

  return { send, stop, pending, status, error, setError, chatViewState };
}
