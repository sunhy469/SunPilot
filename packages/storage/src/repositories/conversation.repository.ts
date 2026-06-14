export interface ConversationRecord {
  id: string;
  title?: string;
  status: "active" | "archived";
  kind?: "project" | "chat";
  createdAt: string;
  updatedAt: string;
}

export interface CreateConversationInput {
  id?: string;
  title?: string;
  kind?: "project" | "chat";
}

export interface ListConversationsInput {
  limit?: number;
  cursor?: string;
}

export interface ConversationRepository {
  create(input?: CreateConversationInput): Promise<ConversationRecord>;
  findById(id: string): Promise<ConversationRecord | null>;
  list(input?: ListConversationsInput): Promise<ConversationRecord[]>;
  touch(id: string): Promise<void>;
  delete(id: string): Promise<boolean>;
}
