import type { createRequest } from "../../shared/api/client";
import type { RunStatus } from "@sunpilot/protocol";
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

export function updateConversation(
  request: Request,
  id: string,
  patch: { title?: string; pinned?: boolean },
) {
  return request<Conversation>(endpoints.conversationById(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function deleteConversation(request: Request, id: string) {
  return request<{ ok: boolean }>(endpoints.conversationById(id), {
    method: "DELETE",
  });
}

export function touchConversation(request: Request, id: string) {
  return request<Conversation>(`${endpoints.conversationById(id)}/touch`, {
    method: "POST",
  });
}

export interface ActiveRun {
  runId: string;
  status: RunStatus;
  continuationKind: "approval" | "user_input" | "interrupted" | null;
}

export function getActiveRun(request: Request, conversationId: string) {
  return request<ActiveRun | null>(endpoints.conversationActiveRun(conversationId));
}
