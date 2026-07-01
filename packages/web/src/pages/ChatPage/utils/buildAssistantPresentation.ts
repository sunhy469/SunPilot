/**
 * buildAssistantPresentation — pure-function layer that merges raw
 * AssistantMessagePart[] streams into two product view models:
 *
 *   ThinkingStep[]    → ThinkingProcessSection (collapsible)
 *   UserFacingBlock[] → main conversation area
 *
 * This layer does NOT hold React state. It is deterministic and can be
 * tested independently for out-of-order events, replays, parallel tool
 * calls, and backward compatibility with legacy messages.
 */

import type {
  AssistantMessagePart,
  AssistantTextPart,
  AssistantStatusPart,
  AssistantToolUsePart,
  AssistantToolResultPart,
  AssistantErrorPart,
} from "../../../features/conversations/types";

// ── Thinking step view models ──────────────────────────────────────────

export type ThinkingStep =
  | PhaseStep
  | NarrativeStep
  | ToolStep;

export interface PhaseStep {
  kind: "phase";
  key: string;
  label: string;
  status: "running" | "completed" | "failed";
}

export interface NarrativeStep {
  kind: "narrative";
  key: string;
  content: string;
}

export interface ToolStep {
  kind: "tool";
  key: string;
  toolCallId: string;
  name: string;
  status: "running" | "completed" | "failed" | "interrupted";
  inputPreview?: Record<string, unknown>;
  resultSummary?: string;
  /** §P2: Technical error detail shown in the step's expandable detail. */
  errorDetail?: string;
}

// ── User-facing block view models ──────────────────────────────────────

export type UserFacingBlock =
  | AnswerBlock
  | UserPromptBlock
  | FatalErrorBlock;

export interface AnswerBlock {
  kind: "answer";
  content: string;
  partId: string;
  /** A streaming progress part whose final role is not known yet. */
  provisional?: boolean;
}

export interface UserPromptBlock {
  kind: "user_prompt";
  content: string;
  partId: string;
}

export interface FatalErrorBlock {
  kind: "fatal_error";
  message: string;
  code?: string;
  partId: string;
}

// ── Main entry points ──────────────────────────────────────────────────

/**
 * Build thinking steps from raw message parts.
 *
 * Rules:
 * 1. Group status + tool_use + tool_result + error by toolCallId.
 * 2. Count logical steps, not raw parts.
 * 3. Hide no-information transitional phases after completion.
 * 4. Failed tool rows show only one title line.
 * 5. Technical errors go into the step's expandable detail.
 */
export function buildThinkingSteps(
  parts: AssistantMessagePart[],
): ThinkingStep[] {
  // Phase 1: Collect tool calls by toolCallId
  const toolCallMap = new Map<string, {
    name: string;
    status: ToolStep["status"];
    inputPreview?: Record<string, unknown>;
    resultSummary?: string;
    errorDetail?: string;
    firstIndex: number;
  }>();

  const standaloneStatuses: Array<{
    key: string;
    label: string;
    status: PhaseStep["status"];
    toolCallId?: string;
  }> = [];
  const indexedNarratives: Array<{ index: number; step: NarrativeStep }> = [];

  for (const [partIndex, part] of parts.entries()) {
    if (part.type === "text") {
      const textPart = part as AssistantTextPart;
      if (
        textPart.content &&
        textPart.status === "completed" &&
        textPart.semanticRole !== "final" &&
        textPart.semanticRole !== "user_prompt"
      ) {
        indexedNarratives.push({
          index: partIndex,
          step: {
            kind: "narrative",
            key: textPart.id,
            content: textPart.content,
          },
        });
      }
    } else if (part.type === "status") {
      const statusPart = part as AssistantStatusPart;
      if (statusPart.toolCallId) {
        // Belongs to a tool call
        const existing = toolCallMap.get(statusPart.toolCallId);
        if (existing) {
          // Status label like "失败: xxx" updates the step status
          if (
            statusPart.status === "failed" &&
            existing.status !== "interrupted"
          ) {
            existing.status = "failed";
          } else if (
            statusPart.status === "completed" &&
            existing.status === "running"
          ) {
            existing.status = "completed";
          }
        } else {
          toolCallMap.set(statusPart.toolCallId, {
            name: toolNameFromStatus(statusPart.label),
            status: statusPart.status === "failed"
              ? "failed"
              : statusPart.status === "completed"
                ? "completed"
                : "running",
            firstIndex: partIndex,
          });
        }
      } else {
        // Standalone phase status
        standaloneStatuses.push({
          key: statusPart.id,
          label: statusPart.label,
          status: statusPart.status,
        });
      }
    } else if (part.type === "tool_use") {
      const toolPart = part as AssistantToolUsePart;
      const existing = toolCallMap.get(toolPart.toolCallId);
      if (existing) {
        existing.name = toolPart.name || existing.name;
        existing.inputPreview = toolPart.inputPreview ?? existing.inputPreview;
        // Terminal states must survive out-of-order started/updated events.
        if (toolPart.status === "interrupted") {
          existing.status = "interrupted";
        } else if (
          toolPart.status === "failed" &&
          existing.status !== "interrupted"
        ) {
          existing.status = "failed";
        } else if (
          toolPart.status === "completed" &&
          existing.status === "running"
        ) {
          existing.status = "completed";
        }
      } else {
        toolCallMap.set(toolPart.toolCallId, {
          name: toolPart.name,
          status: mapToolUseStatus(toolPart.status),
          inputPreview: toolPart.inputPreview,
          firstIndex: partIndex,
        });
      }
    } else if (part.type === "tool_result") {
      const resultPart = part as AssistantToolResultPart;
      const existing = toolCallMap.get(resultPart.toolCallId);
      if (existing) {
        existing.resultSummary = resultPart.summary;
      } else {
        toolCallMap.set(resultPart.toolCallId, {
          name: resultPart.skillId,
          status: "completed",
          resultSummary: resultPart.summary,
          firstIndex: partIndex,
        });
      }
    } else if (part.type === "error") {
      const errorPart = part as AssistantErrorPart;
      // §P2: step_detail errors get merged into their tool step
      if (
        errorPart.presentation === "step_detail" &&
        errorPart.toolCallId
      ) {
        const existing = toolCallMap.get(errorPart.toolCallId);
        if (existing) {
          existing.errorDetail = existing.errorDetail
            ? `${existing.errorDetail}; ${errorPart.message}`
            : errorPart.message;
          existing.status = "failed";
        } else {
          toolCallMap.set(errorPart.toolCallId, {
            name: "工具调用",
            status: "failed",
            errorDetail: errorPart.message,
            firstIndex: partIndex,
          });
        }
      } else if (
        // §P2 backward compat: recoverable errors without explicit presentation
        // are treated as step_detail
        errorPart.recoverable &&
        !errorPart.presentation
      ) {
        // If we can associate it with a tool call via adjacent order, do so.
        // Otherwise skip — don't render as standalone in thinking section.
        if (errorPart.toolCallId) {
          const existing = toolCallMap.get(errorPart.toolCallId);
          if (existing) {
            existing.errorDetail = existing.errorDetail
              ? `${existing.errorDetail}; ${errorPart.message}`
              : errorPart.message;
            existing.status = "failed";
          } else {
            toolCallMap.set(errorPart.toolCallId, {
              name: "工具调用",
              status: "failed",
              errorDetail: errorPart.message,
              firstIndex: partIndex,
            });
          }
        }
      }
    }
  }

  // Phase 2: Build thinking steps
  const indexedSteps: Array<{ index: number; step: ThinkingStep }> = [
    ...indexedNarratives,
  ];

  // Deduplicate and filter standalone statuses
  const seenLabels = new Set<string>();
  for (const st of standaloneStatuses) {
    // Filter out "正在分析需求…" after completion (no information value)
    if (
      st.status === "completed" &&
      (st.label === "正在分析需求…" || st.label === "正在理解需求…")
    ) {
      continue;
    }
    // Deduplicate by label
    const dedupKey = `${st.label}:${st.status}`;
    if (seenLabels.has(dedupKey)) continue;
    seenLabels.add(dedupKey);

    indexedSteps.push({
      index: parts.findIndex((part) => part.id === st.key),
      step: {
        kind: "phase",
        key: st.key,
        label: st.label,
        status: st.status,
      },
    });
  }

  // Add tool steps
  for (const [toolCallId, info] of toolCallMap) {
    indexedSteps.push({
      index: info.firstIndex,
      step: {
        kind: "tool",
        key: toolCallId,
        toolCallId,
        name: info.name,
        status: info.status,
        inputPreview: info.inputPreview,
        resultSummary: info.resultSummary,
        errorDetail: info.errorDetail,
      },
    });
  }

  return indexedSteps
    .sort((left, right) => left.index - right.index)
    .map(({ step }) => step);
}

/**
 * Build user-facing blocks from raw message parts.
 *
 * Rules:
 * - "final" and "user_prompt" text → main area
 * - "progress" text → thinking only (not included here)
 * - fatal errors → main area error card
 * - step_detail errors → thinking only (not included here)
 */
export function buildUserFacingBlocks(
  parts: AssistantMessagePart[],
  options: { includeStreamingProgress?: boolean } = {},
): UserFacingBlock[] {
  const blocks: UserFacingBlock[] = [];

  for (const part of parts) {
    if (part.type === "text") {
      const textPart = part as AssistantTextPart;
      const role = textPart.semanticRole;

      if (!textPart.content) continue;

      if (role === "final") {
        blocks.push({
          kind: "answer",
          content: textPart.content,
          partId: textPart.id,
        });
      } else if (role === "user_prompt") {
        blocks.push({
          kind: "user_prompt",
          content: textPart.content,
          partId: textPart.id,
        });
      } else if (
        role === "progress" &&
        textPart.status === "streaming" &&
        options.includeStreamingProgress
      ) {
        // A ReAct model turn starts as progress because tool calls are only
        // known when the turn finishes. Render the active text provisionally
        // so deltas remain visible; its definitive role still comes from Core.
        blocks.push({
          kind: "answer",
          content: textPart.content,
          partId: textPart.id,
          provisional: true,
        });
      }
      // "progress" text is excluded — thinking section only
    } else if (part.type === "error") {
      const errorPart = part as AssistantErrorPart;

      // §P2: Only fatal errors create standalone blocks
      const isFatal =
        errorPart.presentation === "fatal" ||
        errorPart.scope === "run" ||
        (!errorPart.recoverable && !errorPart.presentation);

      if (isFatal) {
        blocks.push({
          kind: "fatal_error",
          message: errorPart.message,
          code: errorPart.code,
          partId: errorPart.id,
        });
      }
      // step_detail errors are merged into tool steps — not shown here
    }
  }

  return blocks;
}

function toolNameFromStatus(label: string): string {
  return label
    .replace(/^(?:正在调用工具[:：]?|失败[:：]?|完成[:：]?|已完成[:：]?)/, "")
    .trim() || "工具调用";
}

// ── Helpers ─────────────────────────────────────────────────────────────

function mapToolUseStatus(
  raw: AssistantToolUsePart["status"],
): ToolStep["status"] {
  switch (raw) {
    case "pending":
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "running";
  }
}
