export type MessageRole = "system" | "user" | "assistant";

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateMessageInput {
  id?: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface MessageRepository {
  create(input: CreateMessageInput): Promise<MessageRecord>;
  listByConversationId(conversationId: string): Promise<MessageRecord[]>;
}
