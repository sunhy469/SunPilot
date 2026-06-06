export type AgentMessageRole = "system" | "user" | "assistant";

export interface AgentMessage {
  id: string;
  conversationId: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
}

export interface AgentConversation {
  id: string;
  title?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface AgentChatRequest {
  conversationId?: string;
  message: string;
}

export interface AgentChatResponse {
  conversationId: string;
  message: AgentMessage;
}

export interface AgentChatHooks {
  onUserMessage?(message: AgentMessage): Promise<void> | void;
  onAssistantStarted?(input: {
    conversationId: string;
    messageId: string;
  }): Promise<void> | void;
  onAssistantDelta?(input: {
    conversationId: string;
    messageId: string;
    delta: string;
  }): Promise<void> | void;
  onAssistantMessage?(message: AgentMessage): Promise<void> | void;
}

export interface CreateAgentConversationInput {
  id?: string;
  title?: string;
}

export interface CreateAgentMessageInput {
  id?: string;
  conversationId: string;
  role: AgentMessageRole;
  content: string;
}

export interface AgentConversationStore {
  createConversation(
    input?: CreateAgentConversationInput,
  ): Promise<AgentConversation>;
  findConversationById(id: string): Promise<AgentConversation | null>;
  touchConversation(id: string): Promise<void>;
  createMessage(input: CreateAgentMessageInput): Promise<AgentMessage>;
  listMessages(conversationId: string): Promise<AgentMessage[]>;
}
