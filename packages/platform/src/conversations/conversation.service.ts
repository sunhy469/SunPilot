import type { DatabaseContext } from "@sunpilot/storage";
import type { PlatformRequestContext } from "../context.js";
import type {
  ListConversationsInput,
  ListConversationsResult,
  ListMessagesResult,
  UpdateConversationInput,
} from "./conversation.types.js";
import { toHistoryMessageDto } from "./conversation.mapper.js";

/**
 * 会话业务服务 — 承接产品后端的会话 CRUD、分页、DTO 映射等业务逻辑。
 * 不处理 HTTP 协议层细节（schema parse、status code mapping 等）。
 */
export class ConversationService {
  constructor(private readonly deps: { database: DatabaseContext }) {}

  /** 分页游标编码（与 API 共享层保持一致）。 */
  private paginationCursor(input: { updatedAt: string; id: string }): string {
    return Buffer.from(
      JSON.stringify({ updatedAt: input.updatedAt, id: input.id }),
    ).toString("base64url");
  }

  // ── 列表 ──────────────────────────────────────────────────────────

  async listConversations(
    _context: PlatformRequestContext,
    input: ListConversationsInput,
  ): Promise<ListConversationsResult> {
    // 1. 后续在这里检查 tenant/user/permission
    // 2. 调用 storage 查询（limit+1 判断是否有下一页）
    const conversations = await this.deps.database.conversations.list({
      limit: input.limit + 1,
      cursor: input.cursor,
    });
    const items = conversations.slice(0, input.limit);
    const next =
      conversations.length > input.limit ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: next
        ? this.paginationCursor({ updatedAt: next.updatedAt, id: next.id })
        : undefined,
    };
  }

  // ── 创建 ──────────────────────────────────────────────────────────

  async createConversation(
    _context: PlatformRequestContext,
    title?: string,
  ) {
    return this.deps.database.conversations.create({
      title,
    });
  }

  // ── 详情 ──────────────────────────────────────────────────────────

  async getConversation(
    _context: PlatformRequestContext,
    id: string,
  ) {
    const conversation = await this.deps.database.conversations.findById(id);
    if (!conversation) {
      throw new ConversationNotFoundError(id);
    }
    return conversation;
  }

  // ── 历史消息 ──────────────────────────────────────────────────────

  async listMessages(
    _context: PlatformRequestContext,
    conversationId: string,
  ): Promise<ListMessagesResult> {
    // 先校验会话存在（领域级校验）
    const conversation =
      await this.deps.database.conversations.findById(conversationId);
    if (!conversation) {
      throw new ConversationNotFoundError(conversationId);
    }
    const records =
      await this.deps.database.messages.listByConversationId(conversationId);
    return {
      conversationId,
      items: records.map(toHistoryMessageDto),
    };
  }

  // ── 更新 ──────────────────────────────────────────────────────────

  async updateConversation(
    _context: PlatformRequestContext,
    id: string,
    patch: UpdateConversationInput,
  ) {
    const updated = await this.deps.database.conversations.update(id, patch);
    if (!updated) {
      throw new ConversationNotFoundError(id);
    }
    return updated;
  }

  // ── Touch ──────────────────────────────────────────────────────────

  async touchConversation(
    _context: PlatformRequestContext,
    id: string,
  ) {
    await this.deps.database.conversations.touch(id);
    const updated = await this.deps.database.conversations.findById(id);
    if (!updated) {
      throw new ConversationNotFoundError(id);
    }
    return updated;
  }

  // ── 删除 ──────────────────────────────────────────────────────────

  async deleteConversation(
    _context: PlatformRequestContext,
    id: string,
  ): Promise<{ ok: boolean }> {
    const deleted = await this.deps.database.conversations.delete(id);
    if (!deleted) {
      throw new ConversationNotFoundError(id);
    }
    return { ok: true };
  }
}

/** 领域级会话不存在错误。调用方应映射为 HTTP 404。 */
export class ConversationNotFoundError extends Error {
  public readonly code = "CONVERSATION_NOT_FOUND";

  constructor(public readonly conversationId: string) {
    super(`Conversation not found: ${conversationId}`);
    this.name = "ConversationNotFoundError";
  }
}
