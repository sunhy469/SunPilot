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
    return this.db.messages.create(input);
  }

  async listMessages(conversationId: string): Promise<AgentMessage[]> {
    return this.db.messages.listByConversationId(conversationId);
  }
}
