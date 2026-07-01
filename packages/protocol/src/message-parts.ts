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
   *  - "user_prompt": run not yet complete, but the user needs to read/respond — shown in main product area
   *  When absent, the frontend falls back to the legacy last-text-part rule. */
  semanticRole?: "progress" | "final" | "user_prompt";
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
  /** §P2: Error scope for frontend rendering.
   *  - "tool": failure belongs to a specific tool call — shown in step detail only
   *  - "protocol": protocol-level error (validation, guard) — shown in step detail only
   *  - "run": run-level fatal error — shown as a fatal card in main area */
  scope?: "tool" | "protocol" | "run";
  /** §P2: How the error should be presented.
   *  - "step_detail": inline within the tool step's expandable detail (default for recoverable)
   *  - "fatal": a standalone error card in the main product area */
  presentation?: "step_detail" | "fatal";
  /** §P2: The tool call this error belongs to (when scope is "tool" or "protocol"). */
  toolCallId?: string;
  createdAt: string;
}
