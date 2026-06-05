import type { createRequest } from "../../shared/api/client";
import { endpoints } from "../../shared/api/endpoints";
import type { ListResponse } from "../../shared/types/api";
import type { ChatMessage, Conversation } from "./types";

type Request = ReturnType<typeof createRequest>;

export function listConversations(request: Request) {
  return request<ListResponse<Conversation>>(endpoints.conversations);
}

export function createConversation(request: Request, title = "New Chat") {
  return request<Conversation>(endpoints.conversations, {
    method: "POST",
    body: JSON.stringify({ title })
  });
}

export function getConversationMessages(request: Request, conversationId: string) {
  return request<{ conversationId: string; items: ChatMessage[] }>(endpoints.conversationMessages(conversationId));
}
