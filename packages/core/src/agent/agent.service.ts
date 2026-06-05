import { notFound } from "../errors/index.js";
import type { ChatMessage } from "../llm/index.js";
import { parseAgentChatRequest } from "./agent.schema.js";
import type { AgentChatHooks, AgentChatResponse, AgentConversation, AgentServiceConfig } from "./agent.types.js";

export class AgentService {
  constructor(private readonly config: AgentServiceConfig) {}

  async chat(input: unknown, hooks: AgentChatHooks = {}): Promise<AgentChatResponse> {
    const request = parseAgentChatRequest(input);
    const conversation = await this.getOrCreateConversation(request.conversationId);

    const userMessage = await this.config.conversations.createMessage({
      conversationId: conversation.id,
      role: "user",
      content: request.message
    });
    await hooks.onUserMessage?.(userMessage);

    const history = await this.config.conversations.listMessages(conversation.id);
    const messages: ChatMessage[] = [
      ...(this.config.systemPrompt ? [{ role: "system" as const, content: this.config.systemPrompt }] : []),
      ...history.map((message) => ({
        role: message.role,
        content: message.content
      }))
    ];

    const completion = await this.config.llm.chat({ messages });
    const assistantMessageId = `msg_${crypto.randomUUID()}`;
    await hooks.onAssistantStarted?.({ conversationId: conversation.id, messageId: assistantMessageId });
    if (completion.message.content) {
      await hooks.onAssistantDelta?.({
        conversationId: conversation.id,
        messageId: assistantMessageId,
        delta: completion.message.content
      });
    }

    const assistant = await this.config.conversations.createMessage({
      id: assistantMessageId,
      conversationId: conversation.id,
      role: "assistant",
      content: completion.message.content
    });
    await hooks.onAssistantMessage?.(assistant);

    return {
      conversationId: conversation.id,
      message: assistant
    };
  }

  private async getOrCreateConversation(conversationId: string | undefined): Promise<AgentConversation> {
    if (!conversationId) {
      return this.config.conversations.createConversation();
    }
    const conversation = await this.config.conversations.findConversationById(conversationId);
    if (!conversation) {
      throw notFound(`Unknown conversation: ${conversationId}`);
    }
    return conversation;
  }
}
