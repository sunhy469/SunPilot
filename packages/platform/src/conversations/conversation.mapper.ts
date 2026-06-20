import type { MessageRecord } from "@sunpilot/storage";
import type { HistoryMessageDto } from "./conversation.types.js";

/**
 * 将存储层 MessageRecord 映射为前端消费的历史消息 DTO。
 * 保持现有 API contract 不变：attachments、cards、parts 从 metadata 解构。
 */
export function toHistoryMessageDto(record: MessageRecord): HistoryMessageDto {
  return {
    id: record.id,
    conversationId: record.conversationId,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
    attachments:
      (record.metadata as { attachments?: unknown })?.attachments,
    cards:
      (record.metadata as { richCards?: unknown })?.richCards,
    parts:
      (record.metadata as { parts?: unknown })?.parts,
  };
}
