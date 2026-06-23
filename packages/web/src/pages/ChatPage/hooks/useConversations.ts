import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { createRequest } from "../../../shared/api/client";
import {
  createConversation,
  deleteConversation,
  getConversationMessages,
  listConversations,
  touchConversation,
  updateConversation,
} from "../../../features/conversations/api";
import type { ChatMessage, Conversation } from "../../../features/conversations/types";

type Request = ReturnType<typeof createRequest>;

// ── Merge helper: combine local optimistic messages with server messages ──
// Rules:
//   - Server completed messages override local messages with the same ID
//   - Local pending/streaming messages without a server match are kept
//   - Server messages without a local match are added
//   - User messages with conversationId "pending" get their ID updated

/**
 * Check if two timestamps are within `thresholdMs` of each other.
 */
function closeEnough(a: string, b: string, thresholdMs: number): boolean {
  try {
    return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < thresholdMs;
  } catch {
    return false;
  }
}

/**
 * Find a server user message that matches a local optimistic user message.
 * Used as fallback when ack binding was missed.
 *
 * Matching criteria:
 * - Both are role === "user"
 * - Local id starts with "local_" (optimistic)
 * - Same content
 * - Created within 30 seconds of each other
 */
function findServerMatchForOptimisticUser(
  local: ChatMessage,
  serverMessages: ChatMessage[],
  usedServerIds: Set<string>,
): ChatMessage | undefined {
  if (local.role !== "user" || !local.id.startsWith("local_")) return undefined;
  return serverMessages.find(
    (server) =>
      server.role === "user" &&
      !usedServerIds.has(server.id) &&
      local.content === server.content &&
      closeEnough(local.createdAt, server.createdAt, 30_000),
  );
}

function mergeMessagesById(
  localMessages: ChatMessage[],
  serverMessages: ChatMessage[],
): ChatMessage[] {
  const serverById = new Map<string, ChatMessage>();
  for (const msg of serverMessages) {
    serverById.set(msg.id, msg);
  }

  const result: ChatMessage[] = [];
  const seenIds = new Set<string>();
  const usedServerIds = new Set<string>();

  // First pass: walk through local messages, keeping or replacing
  for (const local of localMessages) {
    const serverVersion = serverById.get(local.id);
    if (serverVersion) {
      // Server has this message — prefer server version (completed state)
      result.push(serverVersion);
      seenIds.add(local.id);
      usedServerIds.add(serverVersion.id);
    } else if (
      local.role === "assistant" &&
      (local.status === "pending" || local.status === "streaming")
    ) {
      // Local optimistic assistant message with no server match — keep it
      result.push(local);
      seenIds.add(local.id);
    } else if (local.role === "user" && local.id.startsWith("local_")) {
      // Optimistic user message — try to find matching server message by content+time
      const match = findServerMatchForOptimisticUser(local, serverMessages, usedServerIds);
      if (match) {
        result.push(match);
        seenIds.add(local.id); // Mark local id as seen so server version doesn't get added again
        usedServerIds.add(match.id);
      } else {
        // No server match yet — keep local optimistic message
        result.push(local);
        seenIds.add(local.id);
      }
    } else if (local.conversationId === "pending") {
      // Local user message that hasn't been confirmed by server yet — keep it
      result.push(local);
      seenIds.add(local.id);
    } else {
      // Local message not on server and not optimistic — keep it
      result.push(local);
      seenIds.add(local.id);
    }
  }

  // Second pass: add server messages not yet in result
  for (const server of serverMessages) {
    if (!usedServerIds.has(server.id)) {
      result.push(server);
    }
  }

  return result;
}

export function useConversations(request: Request, enabled: boolean) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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

  /** Select an existing conversation — replaces messages and updates updatedAt */
  const selectConversation = useCallback(async (id: string) => {
    setActiveConversationId(id);
    const response = await getConversationMessages(request, id);
    setMessages(response.items);
    // Touch conversation to update updatedAt (fire-and-forget)
    touchConversation(request, id).then((updated) => {
      if (updated) {
        setConversations((items) =>
          items.map((item) => (item.id === id ? updated : item)),
        );
      }
    }).catch(() => {/* non-critical */});
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
    void getConversationMessages(request, activeConversationId).then((response) => {
      setMessages((current) => mergeMessagesById(current, response.items));
    });
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
