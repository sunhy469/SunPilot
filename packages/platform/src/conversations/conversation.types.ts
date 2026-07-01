import type { ConversationRecord, MessageRecord } from "@sunpilot/storage";
import type { RunStatus } from "@sunpilot/protocol";

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

// ── 活跃 Run 查询（页面刷新恢复） ─────────────────────────────────────

export interface ActiveRunResult {
  runId: string;
  status: RunStatus;
  continuationKind: "approval" | "user_input" | "interrupted" | null;
}

// ── 更新 ──────────────────────────────────────────────────────────────

export interface UpdateConversationInput {
  title?: string;
  pinned?: boolean;
}
