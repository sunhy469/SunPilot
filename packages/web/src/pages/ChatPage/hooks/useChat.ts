import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createChatSocket, sendChatMessage } from "../../../features/chat/ws";
import type { ChatMessage } from "../../../features/conversations/types";

export function useChat(token: string, conversationId: string, setConversationId: (id: string) => void, setMessages: Dispatch<SetStateAction<ChatMessage[]>>) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"online" | "offline" | "thinking">("offline");
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);
  const responseTimerRef = useRef<number | null>(null);

  const clearResponseTimer = useCallback(() => {
    if (responseTimerRef.current === null) return;
    window.clearTimeout(responseTimerRef.current);
    responseTimerRef.current = null;
  }, []);

  const startResponseTimer = useCallback(() => {
    clearResponseTimer();
    responseTimerRef.current = window.setTimeout(() => {
      setPending(false);
      setStatus(socketRef.current?.readyState === WebSocket.OPEN ? "online" : "offline");
      setError("Chat request timed out before the daemon returned a response.");
    }, 90_000);
  }, [clearResponseTimer]);

  const ensureSocket = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return socketRef.current;
    const socket = createChatSocket(token);
    socketRef.current = socket;
    const openTimer = window.setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        socket.close();
        setPending(false);
        setStatus("offline");
        setError("WebSocket connection to the daemon timed out.");
      }
    }, 10_000);
    socket.addEventListener("open", () => {
      window.clearTimeout(openTimer);
      setStatus((current) => current === "thinking" ? "thinking" : "online");
    });
    socket.addEventListener("error", () => {
      window.clearTimeout(openTimer);
      clearResponseTimer();
      setPending(false);
      setStatus("offline");
      setError("WebSocket connection to the daemon failed.");
    });
    socket.addEventListener("close", (event) => {
      window.clearTimeout(openTimer);
      clearResponseTimer();
      setStatus("offline");
      setPending(false);
      if (event.code !== 1000 && event.code !== 4000) {
        setError(event.reason || "WebSocket connection to the daemon closed unexpectedly.");
      }
    });
    socket.addEventListener("message", (raw) => {
      const payload = JSON.parse(String(raw.data)) as any;
      if (payload.error) {
        clearResponseTimer();
        setError(payload.error.message);
        setPending(false);
        setStatus("online");
        return;
      }
      if (payload.method === "chat.message.created") {
        setConversationId(payload.params.conversationId);
        setMessages((items) => [...items.filter((item) => item.id !== payload.params.message.id), payload.params.message]);
      }
      if (payload.method === "chat.assistant.started") {
        setStatus("thinking");
        setMessages((items) => [
          ...items,
          { id: payload.params.messageId, conversationId: payload.params.conversationId, role: "assistant", content: "", createdAt: new Date().toISOString() }
        ]);
      }
      if (payload.method === "chat.assistant.delta") {
        startResponseTimer();
        setMessages((items) => items.map((item) => item.id === payload.params.messageId ? { ...item, content: item.content + payload.params.delta } : item));
      }
      if (payload.method === "chat.assistant.completed") {
        clearResponseTimer();
        setStatus("online");
        setPending(false);
        setMessages((items) => items.map((item) => item.id === payload.params.message.id ? payload.params.message : item));
      }
    });
    return socket;
  }, [clearResponseTimer, setConversationId, setMessages, startResponseTimer, token]);

  const send = useCallback((message: string) => {
    const text = message.trim();
    if (!text || pending) return;
    setPending(true);
    setStatus("thinking");
    setError("");
    startResponseTimer();
    const socket = ensureSocket();
    const transmit = () => sendChatMessage(socket, { ...(conversationId ? { conversationId } : {}), message: text });
    if (socket.readyState === WebSocket.OPEN) transmit();
    else socket.addEventListener("open", transmit, { once: true });
  }, [conversationId, ensureSocket, pending, startResponseTimer]);

  useEffect(() => () => {
    clearResponseTimer();
    socketRef.current?.close();
  }, [clearResponseTimer]);

  return { send, pending, status, error, setError };
}
