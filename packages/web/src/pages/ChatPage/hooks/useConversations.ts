import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { createRequest } from "../../../shared/api/client";
import {
  createConversation,
  deleteConversation,
  getConversationMessages,
  listConversations,
  updateConversation,
} from "../../../features/conversations/api";
import type { ChatMessage, Conversation } from "../../../features/conversations/types";

type Request = ReturnType<typeof createRequest>;

export function useConversations(request: Request, enabled: boolean) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const newChatRequestedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const response = await listConversations(request);
    setConversations(response.items);
    // Don't auto-select if user explicitly requested a new chat
    if (!activeConversationId && response.items[0] && !newChatRequestedRef.current) {
      setActiveConversationId(response.items[0].id);
    }
    newChatRequestedRef.current = false;
  }, [activeConversationId, enabled, request]);

  /** 点击"新对话"：仅清空聊天区，不创建 DB 记录 */
  const newChat = useCallback(() => {
    newChatRequestedRef.current = true;
    setActiveConversationId("");
    setMessages([]);
  }, []);

  /** 确保会话存在（首次发消息时调用），标题 = 首条消息内容 */
  const ensureConversation = useCallback(
    async (firstMessage: string): Promise<Conversation> => {
      const conversation = await createConversation(request, firstMessage.slice(0, 100));
      setConversations((items) => [conversation, ...items.filter((item) => item.id !== conversation.id)]);
      setActiveConversationId(conversation.id);
      return conversation;
    },
    [request],
  );

  /** WS 事件触发：后端自动创建的会话，前端需要根据 ID 拉取详情后加入列表 */
  const addConversationById = useCallback(
    async (conversationId: string) => {
      // Fetch the conversation from API to get full details (title, etc.)
      try {
        const conv = await request<Conversation>(`/v1/conversations/${conversationId}`);
        setConversations((items) => {
          if (items.some((item) => item.id === conv.id)) return items;
          return [conv, ...items];
        });
        setActiveConversationId(conv.id);
      } catch {
        // If fetch fails, still set the ID so messages can flow
        setActiveConversationId(conversationId);
      }
    },
    [request],
  );

  const selectConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    const response = await getConversationMessages(request, id);
    setMessages(response.items);
  }, [request]);

  const renameConversation = useCallback(
    async (id: string, title: string) => {
      const updated = await updateConversation(request, id, { title });
      setConversations((items) =>
        items.map((item) => (item.id === id ? updated : item)),
      );
    },
    [request],
  );

  const removeConversation = useCallback(
    async (id: string) => {
      try {
        await deleteConversation(request, id);
      } catch (error) {
        console.error("Failed to delete conversation:", error);
        throw error;
      }

      setConversations((items) => items.filter((item) => item.id !== id));

      if (activeConversationId === id) {
        // Switch to the first remaining conversation (use current conversations
        // state since setConversations hasn't flushed yet)
        const remaining = conversations.filter((item) => item.id !== id);
        const next = remaining[0];
        if (next) {
          setActiveConversationId(next.id);
          void getConversationMessages(request, next.id).then((r) =>
            setMessages(r.items),
          );
        } else {
          setActiveConversationId("");
          setMessages([]);
        }
      }
    },
    [activeConversationId, conversations, request],
  );

  const togglePin = useCallback(
    async (id: string, pinned: boolean) => {
      const updated = await updateConversation(request, id, { pinned });
      setConversations((items) =>
        items.map((item) => (item.id === id ? updated : item)),
      );
    },
    [request],
  );

  /** 按置顶优先 + 最近更新排序 */
  const sortedConversations = useMemo(() => {
    return [...conversations].sort((a, b) => {
      const ap = a.pinned ? 1 : 0;
      const bp = b.pinned ? 1 : 0;
      if (bp !== ap) return bp - ap;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }, [conversations]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!activeConversationId || !enabled) return;
    void getConversationMessages(request, activeConversationId).then((response) => setMessages(response.items));
  }, [activeConversationId, enabled, request]);

  return {
    conversations: sortedConversations,
    activeConversationId,
    messages,
    setMessages,
    refresh,
    newChat,
    ensureConversation,
    addConversationById,
    selectConversation,
    renameConversation,
    deleteConversation: removeConversation,
    togglePin,
    setActiveConversationId,
  };
}
