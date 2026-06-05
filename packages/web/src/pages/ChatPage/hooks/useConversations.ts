import { useCallback, useEffect, useState } from "react";
import type { createRequest } from "../../../shared/api/client";
import { createConversation, getConversationMessages, listConversations } from "../../../features/conversations/api";
import type { ChatMessage, Conversation } from "../../../features/conversations/types";

type Request = ReturnType<typeof createRequest>;

export function useConversations(request: Request, enabled: boolean) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const response = await listConversations(request);
    setConversations(response.items);
    if (!activeConversationId && response.items[0]) setActiveConversationId(response.items[0].id);
  }, [activeConversationId, enabled, request]);

  const newChat = useCallback(async () => {
    const conversation = await createConversation(request);
    setConversations((items) => [conversation, ...items.filter((item) => item.id !== conversation.id)]);
    setActiveConversationId(conversation.id);
    setMessages([]);
  }, [request]);

  const selectConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    const response = await getConversationMessages(request, id);
    setMessages(response.items);
  }, [request]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!activeConversationId || !enabled) return;
    void getConversationMessages(request, activeConversationId).then((response) => setMessages(response.items));
  }, [activeConversationId, enabled, request]);

  return { conversations, activeConversationId, messages, setMessages, refresh, newChat, selectConversation, setActiveConversationId };
}
