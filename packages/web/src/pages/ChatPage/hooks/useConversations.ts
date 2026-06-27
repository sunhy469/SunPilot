import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { createRequest } from "../../../shared/api/client";
import { endpoints } from "../../../shared/api/endpoints";
import {
  createConversation,
  deleteConversation,
  listConversations,
  touchConversation,
  updateConversation,
} from "../../../features/conversations/api";
import type { ChatMessage, Conversation } from "../../../features/conversations/types";
import { mergeMessagesById } from "./conversation-message-merge";

type Request = ReturnType<typeof createRequest>;

export function useConversations(request: Request, enabled: boolean) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /** True while messages are being fetched for the current conversation. */
  const [loadingMessages, setLoadingMessages] = useState(false);
  const newChatRequestedRef = useRef(false);
  /** Track whether this is the initial load (no conversation has been selected yet) */
  const initialLoadRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const response = await listConversations(request);
    setConversations(response.items);
    // On initial load, show the welcome/new-chat page instead of auto-selecting
    // a conversation. Only auto-select on subsequent refreshes if the user
    // hasn't explicitly requested a new chat.
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      return;
    }
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
    setLoadingMessages(false);
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

  /** Select an existing conversation — immediately clears messages and sets
   *  active id for instant UI feedback. Messages are loaded async by the
   *  activeConversationId useEffect (single source of truth, avoids double fetch). */
  const selectConversation = useCallback((id: string) => {
    // If selecting the same conversation, no-op
    if (id === activeConversationId) return;
    // Clear old messages immediately so the UI doesn't show stale content
    // from the previous conversation while the new messages load.
    setMessages([]);
    setLoadingMessages(true);
    setActiveConversationId(id);
    // Touch conversation to update updatedAt (fire-and-forget)
    touchConversation(request, id).then((updated) => {
      if (updated) {
        setConversations((items) =>
          items.map((item) => (item.id === id ? updated : item)),
        );
      }
    }).catch(() => {/* non-critical */});
  }, [request, activeConversationId]);

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

      // W1: use the functional update form to compute remaining from the latest
      // state (avoids stale `conversations` closure). The next active id is
      // captured from the fresh list inside the updater.
      let nextId = "";
      setConversations((items) => {
        const remaining = items.filter((item) => item.id !== id);
        if (activeConversationId === id) {
          nextId = remaining[0]?.id ?? "";
        }
        return remaining;
      });

      if (activeConversationId === id) {
        if (nextId) {
          // messages will be loaded by the activeConversationId useEffect
          setActiveConversationId(nextId);
        } else {
          setActiveConversationId("");
          setMessages([]);
        }
      }
    },
    [activeConversationId, request],
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
      const aTime = a.updatedAt ?? a.createdAt ?? "";
      const bTime = b.updatedAt ?? b.createdAt ?? "";
      return bTime.localeCompare(aTime);
    });
  }, [conversations]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!activeConversationId || !enabled) return;
    // AbortController: cancel in-flight fetch when id changes or component unmounts,
    // preventing stale responses from overwriting the current conversation's messages.
    setLoadingMessages(true);
    const controller = new AbortController();
    const targetConversationId = activeConversationId;
    request<{ conversationId: string; items: ChatMessage[] }>(
      endpoints.conversationMessages(activeConversationId),
      { signal: controller.signal },
    )
      .then((response) => {
        setMessages((current) => {
          // Defensive: filter out messages from other conversations that may
          // have been added by concurrent effects (e.g. event replay).
          const filtered = current.filter(
            (m) => m.conversationId === targetConversationId,
          );
          return mergeMessagesById(filtered, response.items);
        });
        setLoadingMessages(false);
      })
      .catch((err: unknown) => {
        // AbortError is expected when switching conversations or unmounting
        if (err instanceof DOMException && err.name === "AbortError") return;
        // Other errors are non-critical; messages will retry on next refresh
        setLoadingMessages(false);
      });
    return () => controller.abort();
  }, [activeConversationId, enabled, request]);

  return {
    conversations: sortedConversations,
    activeConversationId,
    messages,
    setMessages,
    loadingMessages,
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
