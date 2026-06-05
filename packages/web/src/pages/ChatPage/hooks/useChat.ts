import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { createChatSocket, sendChatMessage } from "../../../features/chat/ws";
import type { ChatMessage } from "../../../features/conversations/types";

export function useChat(token: string, conversationId: string, setConversationId: (id: string) => void, setMessages: Dispatch<SetStateAction<ChatMessage[]>>) {
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<"online" | "offline" | "thinking">("offline");
  const [error, setError] = useState("");
  const socketRef = useRef<WebSocket | null>(null);

  const ensureSocket = useCallback(() => {
    if (socketRef.current && socketRef.current.readyState <= WebSocket.OPEN) return socketRef.current;
    const socket = createChatSocket(token);
    socketRef.current = socket;
    socket.addEventListener("open", () => setStatus("online"));
    socket.addEventListener("close", (event) => {
      setStatus("offline");
      if (event.code !== 4000) setPending(false);
    });
    socket.addEventListener("message", (raw) => {
      const payload = JSON.parse(String(raw.data)) as any;
      if (payload.error) {
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
        setMessages((items) => items.map((item) => item.id === payload.params.messageId ? { ...item, content: item.content + payload.params.delta } : item));
      }
      if (payload.method === "chat.assistant.completed") {
        setStatus("online");
        setPending(false);
        setMessages((items) => items.map((item) => item.id === payload.params.message.id ? payload.params.message : item));
      }
    });
    return socket;
  }, [setConversationId, setMessages, token]);

  const send = useCallback((message: string) => {
    const text = message.trim();
    if (!text || pending) return;
    setPending(true);
    setError("");
    const socket = ensureSocket();
    const transmit = () => sendChatMessage(socket, { ...(conversationId ? { conversationId } : {}), message: text });
    if (socket.readyState === WebSocket.OPEN) transmit();
    else socket.addEventListener("open", transmit, { once: true });
  }, [conversationId, ensureSocket, pending]);

  useEffect(() => () => socketRef.current?.close(), []);

  return { send, pending, status, error, setError };
}
