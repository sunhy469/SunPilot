import type { RichCardView } from "../../rich-cards";

export interface Conversation {
  id: string;
  title?: string;
  status: "active" | "archived";
  kind?: "project" | "chat";
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
  cards?: RichCardView[];
}
