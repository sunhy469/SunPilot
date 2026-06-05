import type { AgentConversation, AgentConversationStore, AgentMessage, CreateAgentConversationInput, CreateAgentMessageInput } from "./agent.types.js";

export class InMemoryAgentConversationStore implements AgentConversationStore {
  private readonly conversations = new Map<string, AgentConversation>();
  private readonly messages = new Map<string, AgentMessage[]>();

  async createConversation(input: CreateAgentConversationInput = {}): Promise<AgentConversation> {
    const now = new Date().toISOString();
    const conversation: AgentConversation = {
      id: input.id ?? `conv_${crypto.randomUUID()}`,
      title: input.title,
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.conversations.set(conversation.id, conversation);
    this.messages.set(conversation.id, []);
    return conversation;
  }

  async findConversationById(id: string): Promise<AgentConversation | null> {
    return this.conversations.get(id) ?? null;
  }

  async touchConversation(id: string): Promise<void> {
    const conversation = this.conversations.get(id);
    if (!conversation) return;
    this.conversations.set(id, { ...conversation, updatedAt: new Date().toISOString() });
  }

  async createMessage(input: CreateAgentMessageInput): Promise<AgentMessage> {
    const conversation = this.conversations.get(input.conversationId);
    if (!conversation) {
      throw new Error(`Unknown conversation: ${input.conversationId}`);
    }
    const message: AgentMessage = {
      id: input.id ?? `msg_${crypto.randomUUID()}`,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      createdAt: new Date().toISOString()
    };
    this.messages.set(input.conversationId, [...(this.messages.get(input.conversationId) ?? []), message]);
    await this.touchConversation(input.conversationId);
    return message;
  }

  async listMessages(conversationId: string): Promise<AgentMessage[]> {
    return [...(this.messages.get(conversationId) ?? [])];
  }
}
