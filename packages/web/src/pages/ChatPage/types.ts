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

/**
 * Local send state — tracks the lifecycle of a user message from composition
 * through upload, transmission, acknowledgment, and completion.
 *
 * Architecture doc §12.5: all user actions must show instant UI feedback.
 */
export type LocalSendState =
  | "editing"
  | "uploading"
  | "queued_until_upload_done"
  | "sending"
  | "accepted"
  | "running"
  | "streaming"
  | "completed"
  | "failed";

export interface ChatMessageView {
  id: string;
  role: MessageRole;
  content: string;
  createdAt?: string;
  status?: MessageStatus;
  cards?: RichCardView[];
}
