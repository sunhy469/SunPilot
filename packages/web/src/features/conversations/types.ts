import type { RichCardView } from "../../rich-cards";

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

// ── Content-block message parts (§Phase 1 of streaming refactoring) ──

export type AssistantMessagePart =
  | AssistantTextPart
  | AssistantStatusPart
  | AssistantToolUsePart
  | AssistantToolResultPart
  | AssistantErrorPart;

export interface AssistantTextPart {
  id: string;
  type: "text";
  content: string;
  source: "model";
  status: "streaming" | "completed";
  /** Stable semantic role for frontend rendering (§P0-1).
   *  - "progress": pre-tool text (thinking/reasoning) — shown in thinking section
   *  - "final": post-tool final answer — shown in main product area
   *  When absent, the frontend falls back to the legacy last-text-part rule. */
  semanticRole?: "progress" | "final";
  createdAt: string;
  completedAt?: string;
}

export interface AssistantStatusPart {
  id: string;
  type: "status";
  label: string;
  status: "running" | "completed" | "failed";
  toolCallId?: string;
  runId: string;
  createdAt: string;
  completedAt?: string;
  metadata?: {
    skillId?: string;
    phase?: "queued" | "running" | "polling" | "completed" | "local_pending";
    progress?: number;
  };
}

export interface AssistantToolUsePart {
  id: string;
  type: "tool_use";
  toolCallId: string;
  skillId: string;
  name: string;
  inputPreview?: Record<string, unknown>;
  status: "pending" | "running" | "completed" | "failed";
  createdAt: string;
}

export interface AssistantToolResultPart {
  id: string;
  type: "tool_result";
  toolCallId: string;
  skillId: string;
  summary: string;
  artifactIds?: string[];
  trust?: "trusted" | "untrusted";
  visible: "collapsed" | "hidden" | "expanded";
  createdAt: string;
}

export interface AssistantErrorPart {
  id: string;
  type: "error";
  message: string;
  code?: string;
  recoverable?: boolean;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
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
