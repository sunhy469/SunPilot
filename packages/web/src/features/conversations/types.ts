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
  /** Transient UI status for local optimistic updates (pending/streaming/completed). */
  status?: "pending" | "streaming" | "completed" | "error" | "stopped";
  cards?: RichCardView[];
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes?: number;
    url?: string;
    storageKey?: string;
  }>;
}
