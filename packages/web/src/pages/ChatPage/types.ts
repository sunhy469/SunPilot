import type { RichCardView } from "../../rich-cards";

export type AgentStatus = "online" | "offline" | "thinking";

export type ChatViewState =
  | "welcome"
  | "loadingConversation"
  | "ready"
  | "streaming"
  | "offline"
  | "error";

export type MessageRole = "user" | "assistant" | "system";

export type MessageStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "error"
  | "stopped";

export interface ChatMessageView {
  id: string;
  role: MessageRole;
  content: string;
  createdAt?: string;
  status?: MessageStatus;
  cards?: RichCardView[];
}
