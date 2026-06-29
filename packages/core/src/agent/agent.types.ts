export type AgentMessageRole = "system" | "user" | "assistant";

import type { AssistantMessagePart, ChatSendParams } from "@sunpilot/protocol";

export interface AgentMessage {
  id: string;
  conversationId: string;
  role: AgentMessageRole;
  content: string;
  createdAt: string;
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes?: number;
    url?: string;
    dataUrl?: string;
    storageKey?: string;
    provider?: "aliyun-oss" | "s3" | "minio" | "local";
    checksum?: string;
  }>;
  /** Content-block parts from metadata.parts (§P0-3). */
  parts?: AssistantMessagePart[];
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
  attachments: ChatSendParams["attachments"];
}

export interface AgentChatResponse {
  conversationId: string;
  message: AgentMessage;
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
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes?: number;
    url?: string;
    dataUrl?: string;
    storageKey?: string;
    provider?: "aliyun-oss" | "s3" | "minio" | "local";
    checksum?: string;
  }>;
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
