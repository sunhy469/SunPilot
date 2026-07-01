import type { RichCardView } from "../../rich-cards";
import type {
  AssistantMessagePart,
  AssistantTextPart,
  AssistantStatusPart,
  AssistantToolUsePart,
  AssistantToolResultPart,
  AssistantErrorPart,
} from "@sunpilot/protocol";

export type {
  AssistantMessagePart,
  AssistantTextPart,
  AssistantStatusPart,
  AssistantToolUsePart,
  AssistantToolResultPart,
  AssistantErrorPart,
} from "@sunpilot/protocol";

export interface AgentActivity {
  id: string;
  kind: "thinking" | "tool" | "model" | "result" | "error";
  label: string;
  detail?: string;
  status?: "running" | "completed" | "failed";
  createdAt: string;
}

export interface Conversation {
  id: string;
  title?: string;
  status: "active" | "archived";
  kind?: "project" | "chat";
  pinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  /** Agent run that owns this assistant message (set by message.started). */
  runId?: string;
  conversationId: string;
  role: "system" | "user" | "assistant";
  content: string;
  createdAt: string;
  /** Transient UI status for local optimistic updates (pending/streaming/completed). */
  status?: "pending" | "streaming" | "completed" | "error" | "stopped";
  /** Content-block parts for interleaved text + tool status rendering (§Phase 1). */
  parts?: AssistantMessagePart[];
  /** Legacy event timeline — being replaced by parts. */
  activities?: AgentActivity[];
  cards?: RichCardView[];
  /** Per-card interaction state, keyed by card ID. */
  cardStateByCardId?: Record<string, unknown>;
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes?: number;
    url?: string;
    dataUrl?: string;
    storageKey?: string;
  }>;
  /**
   * Client-generated request ID for optimistic message binding.
   * Used to match local user messages with server-confirmed messages via chat.send ack.
   */
  clientRequestId?: string;
}
