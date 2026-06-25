/**
 * AssistantMessagePart — canonical content-block types.
 *
 * These are the authoritative definitions for the interleaved text +
 * tool status streaming model (§Phase 1+2 of streaming refactoring).
 *
 * Consumers:
 *   - packages/core   → imports from @sunpilot/protocol
 *   - packages/daemon → imports from @sunpilot/protocol
 *   - packages/web    → has its own copy (no @sunpilot/protocol dep yet)
 *
 * When updating these types, keep web's copy in
 *   packages/web/src/features/conversations/types.ts
 * in sync.
 */

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
    phase?: "queued" | "running" | "polling" | "completed" | "summarizing";
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
  /** §B33: "interrupted" marks a tool_use that was left pending/running when
   *  the message was forcibly finalized (e.g. abort/timeout) — the tool did
   *  NOT complete successfully, so "completed" would be misleading. */
  status: "pending" | "running" | "completed" | "failed" | "interrupted";
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
