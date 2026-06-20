import type { ConversationRecord, MessageRecord } from "@sunpilot/storage";

// ── 会话列表 ──────────────────────────────────────────────────────────

export interface ListConversationsInput {
  limit: number;
  cursor?: string;
}

export interface ListConversationsResult {
  items: ConversationRecord[];
  nextCursor?: string;
}

// ── 历史消息 DTO（前端消费格式） ─────────────────────────────────────

export interface HistoryMessageDto {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
  attachments?: unknown;
  cards?: unknown;
  parts?: unknown;
}

export interface ListMessagesResult {
  conversationId: string;
  items: HistoryMessageDto[];
}

// ── 更新 ──────────────────────────────────────────────────────────────

export interface UpdateConversationInput {
  title?: string;
  pinned?: boolean;
}
