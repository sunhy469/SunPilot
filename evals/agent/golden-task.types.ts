/**
 * Golden Task evaluation types.
 *
 * Golden Tasks are fixed test scenarios that encode expected agent behavior.
 * They run after Agent Core changes to detect regressions in critical paths:
 * tool usage, parameter handling, approval flows, and safety boundaries.
 */

import type { AttachmentRef, PermissionMode } from "@sunpilot/core";

// ── Golden Task Definition ──────────────────────────────────────────────

export interface GoldenTask {
  /** Unique task identifier, e.g. "image-search-must-wait-for-tool". */
  id: string;
  /** Human-readable description of what this task verifies. */
  description: string;
  /** Category for grouping in reports. */
  category: GoldenTaskCategory;
  /** The user's input message. */
  userMessage: string;
  /** Optional conversation history to prepopulate. */
  conversationHistory?: GoldenTaskMessage[];
  /** Attachments to include with the user message. */
  attachments?: AttachmentRef[];
  /** Available skills (simplified for test setup). */
  availableSkills: GoldenTaskSkill[];
  /** Permission mode for this task. */
  permissionMode?: PermissionMode;
  /** The expected behavior specification. */
  expectations: GoldenTaskExpectations;
  /** Tags for filtering. */
  tags?: string[];
}

export type GoldenTaskCategory =
  | "tool_usage"
  | "parameter_handling"
  | "approval"
  | "safety"
  | "memory"
  | "context"
  | "reflection"
  | "streaming";

export interface GoldenTaskMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  metadata?: Record<string, unknown>;
}

export interface GoldenTaskSkill {
  id: string;
  name: string;
  description: string;
  category: string;
  inputSchema?: Record<string, unknown>;
  riskHints?: {
    defaultRisk?: "low" | "medium" | "high" | "critical";
    destructiveArgs?: string[];
    externalHosts?: string[];
  };
}

// ── Expectations ────────────────────────────────────────────────────────

export interface GoldenTaskExpectations {
  /** Tool calls that MUST be made (at minimum these skill ids). */
  mustCallTools?: string[];
  /** Tool calls that must NOT be made. */
  mustNotCallTools?: string[];
  /** The final response must contain at least one of these strings. */
  mustContain?: string[];
  /** The final response must NOT contain any of these strings. */
  mustNotContain?: string[];
  /** The agent must NOT fabricate results (answer without tool when tool was needed). */
  mustNotFabricate?: boolean;
  /** The agent must ask for clarification when missing required parameters. */
  mustAskClarification?: boolean;
  /** The agent must NOT exceed this many tool iterations. */
  maxToolIterations?: number;
  /** The run must end with this status. */
  expectedRunStatus?: "completed" | "waiting_approval" | "interrupted" | "cancelled";
  /** Specific tool call sequences that must appear in order. */
  mustCallInOrder?: string[];
  /** The agent must NOT respond before tool results are available. */
  mustWaitForToolResults?: boolean;
}

// ── Evaluation Result ───────────────────────────────────────────────────

export interface GoldenTaskResult {
  taskId: string;
  passed: boolean;
  failures: GoldenTaskFailure[];
  /** Actual tool calls made during execution. */
  actualToolCalls: string[];
  /** Actual tool call sequence (ordered). */
  actualToolSequence: Array<{
    skillId: string;
    status: string;
    summary: string;
  }>;
  /** Context snapshot summary. */
  contextSummary?: {
    messageCount: number;
    memoryCount: number;
    tokenEstimate: number;
  };
  /** Model call statistics. */
  modelCalls: {
    count: number;
    totalTokens: number;
    purpose: string[];
  };
  /** Duration in milliseconds. */
  durationMs: number;
}

export interface GoldenTaskFailure {
  rule: string;
  expected: string;
  actual: string;
}

// ── Evaluation Suite ────────────────────────────────────────────────────

export interface GoldenTaskSuite {
  name: string;
  description: string;
  tasks: GoldenTask[];
}

export interface GoldenTaskReport {
  suiteName: string;
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  results: GoldenTaskResult[];
  summary: string;
}
