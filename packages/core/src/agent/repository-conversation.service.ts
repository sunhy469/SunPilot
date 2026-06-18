import type { DatabaseContext } from "@sunpilot/storage";
import type { AgentConversation, AgentConversationStore, AgentMessage, CreateAgentConversationInput, CreateAgentMessageInput } from "./agent.types.js";

export class RepositoryAgentConversationStore implements AgentConversationStore {
  constructor(private readonly db: Pick<DatabaseContext, "conversations" | "messages">) {}

  async createConversation(input: CreateAgentConversationInput = {}): Promise<AgentConversation> {
    return this.db.conversations.create(input);
  }

  async findConversationById(id: string): Promise<AgentConversation | null> {
    return this.db.conversations.findById(id);
  }

  async touchConversation(id: string): Promise<void> {
    await this.db.conversations.touch(id);
  }

  async createMessage(input: CreateAgentMessageInput): Promise<AgentMessage> {
    const record = await this.db.messages.create({
      id: input.id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      attachments: input.attachments,
    });
    return {
      id: record.id,
      conversationId: record.conversationId,
      role: record.role,
      content: record.content,
      createdAt: record.createdAt,
      attachments: record.metadata?.attachments as AgentMessage["attachments"],
    };
  }

  async listMessages(conversationId: string): Promise<AgentMessage[]> {
    const records = await this.db.messages.listByConversationId(conversationId);
    return records.map((r) => ({
      id: r.id,
      conversationId: r.conversationId,
      role: r.role,
      content: r.content,
      createdAt: r.createdAt,
      attachments: r.metadata?.attachments as AgentMessage["attachments"],
      /** §P0-3: Restore content-block parts from metadata. */
      parts: (r.metadata as { parts?: AgentMessage["parts"] })?.parts,
    }));
  }
}
