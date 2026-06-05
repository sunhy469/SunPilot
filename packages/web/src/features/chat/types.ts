import type { ChatMessage } from "../conversations/types";

export interface ChatSendParams {
  conversationId?: string;
  message: string;
}

export type ChatSocketEvent =
  | { method: "chat.message.created"; params: { conversationId: string; message: ChatMessage } }
  | { method: "chat.assistant.started"; params: { conversationId: string; messageId: string } }
  | { method: "chat.assistant.delta"; params: { conversationId: string; messageId: string; delta: string } }
  | { method: "chat.assistant.completed"; params: { conversationId: string; message: ChatMessage } }
  | { method: "chat.error"; params: { conversationId?: string; error: { message: string } } };
