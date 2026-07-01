import type { AgentEventType } from "@sunpilot/protocol";

// ── Content-block message parts (§Phase 1+2 of streaming refactoring) ─
// Canonical types now live in @sunpilot/protocol (§P2-1).

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
};

/** Save a completed assistant message with metadata. */
export type SaveMessageFn = (msg: {
  id: string;
  conversationId: string;
  role: "assistant";
  content: string;
  runId: string;
  metadata?: Record<string, unknown>;
}) => Promise<void>;

/**
 * Opaque interface for AssistantMessageStream to avoid circular
 * dependency between loop-types.ts and assistant-message-stream.ts.
 */
export interface IAssistantMessageStream {
  readonly runId: string;
  readonly conversationId: string;
  readonly messageId: string;
  start(): void;
  startTextPart(semanticRole?: "progress" | "final"): AssistantTextPart;
  appendText(partId: string, delta: string): void;
  completeTextPart(partId: string): void;
  /** §P0-1/P1-3: Update a text part's semanticRole after creation.
   *  Used when a "progress" text part turns out to be the final answer
   *  (LLM decided not to call tools on a post-tool iteration). */
  updateTextPartRole(partId: string, semanticRole: "progress" | "final"): void;
  startStatus(input: {
    label: string;
    toolCallId?: string;
    metadata?: AssistantStatusPart["metadata"];
  }): AssistantStatusPart;
  updateStatus(
    partId: string,
    patch: Partial<Pick<AssistantStatusPart, "label" | "status"> & {
      completedAt: string;
      metadata: AssistantStatusPart["metadata"];
    }>,
  ): void;
  addToolUse(input: {
    toolCallId: string;
    skillId: string;
    name: string;
    inputPreview?: Record<string, unknown>;
  }): AssistantToolUsePart;
  /** Update a tool_use part's status (pending → running → completed/failed) (§P1-3). */
  updateToolUse(
    toolCallId: string,
    patch: Pick<Partial<AssistantToolUsePart>, "status">,
  ): void;
  addToolResult(input: {
    toolCallId: string;
    skillId: string;
    summary: string;
    artifactIds?: string[];
    trust?: "trusted" | "untrusted";
  }): AssistantToolResultPart;
  hasTextContent(): boolean;
  addError(input: {
    message: string;
    code?: string;
    recoverable?: boolean;
  }): AssistantErrorPart;
  /** §Step 1b: Snapshot current parts without completing. */
  getPartsSnapshot(): AssistantMessagePart[];
  /** Set rich cards for inline rendering (image/video artifacts). */
  setRichCards(cards: Array<import("@sunpilot/protocol").RichCardOutput>): void;
  /** Persist the current resumable message without closing its open parts. */
  persistSnapshot(): Promise<void>;
  complete(outcome?: "completed" | "failed" | "cancelled"): Promise<{
    messageId: string;
    content: string;
    parts: AssistantMessagePart[];
  }>;
}

// ── Agent Loop ────────────────────────────────────────────────────────

export type AgentLoopStatus = import("@sunpilot/protocol").RunStatus;

// ── Loop Input / Output ───────────────────────────────────────────────

export interface AttachmentRef {
  id: string;
  name: string;
  type: string;
  sizeBytes?: number;
  /** Public access URL or backend-downloadable address. */
  url?: string;
  /** Base64-encoded data URL as fallback when no public URL is available.
   *  Limited to 4 MB to avoid overwhelming WebSocket payloads and model context. */
  dataUrl?: string;
  /** OSS object key for backend record-keeping, deletion, and re-signing. */
  storageKey?: string;
  /** OSS provider identifier. */
  provider?: "aliyun-oss" | "s3" | "minio" | "local";
  /** Optional file checksum for integrity verification. */
  checksum?: string;
}

export type PermissionMode = "ask" | "auto" | "full";

export interface AgentLoopInput {
  runId: string;
  conversationId: string;
  userMessageId: string;
  userId?: string;
  message: string;
  mode: "chat" | "agent";
  /** User-selected permission mode controlling tool approval behavior. */
  permissionMode?: PermissionMode;
  /** User-selected chat model. Routes all LLM calls to this model. */
  modelId?: "dp" | "seed";
  attachments?: AttachmentRef[];
  client: {
    source: "web" | "cli" | "api";
    connectionId?: string;
  };
}

export interface AgentLoopResult {
  runId: string;
  conversationId: string;
  assistantMessageId?: string;
  status: AgentLoopStatus;
  artifacts: ArtifactRef[];
  toolCalls: ToolCallSummary[];
  error?: {
    code: string;
    message: string;
    category?: string;
    retryable?: boolean;
  };
}

export interface ArtifactRef {
  id: string;
  name: string;
  type: string;
  version?: number;
}

export interface ToolCallSummary {
  id: string;
  skillId: string;
  name: string;
  status: "completed" | "failed" | "cancelled" | "timeout";
  summary: string;
  /** Full text content of the tool output (e.g., script body, search results).
   *  Used for modelObservation when summary is too terse (§P0-2). */
  content?: string;
  /** Structured tool result retained for observations and audit. */
  structured?: Record<string, unknown>;
  /** Model-facing observation derived from the full tool output (§P0-2).
   *  When set, injectStreamingToolResults uses this instead of summary.
   *  Generated by ToolResultProjection from content + structured fields. */
  modelObservation?: string;
  /** Audit metadata propagated from PlannedToolCall (§P0-2). */
  metadata?: Record<string, unknown>;
  /** Artifacts produced by this specific tool call, preserving batch attribution. */
  artifactIds?: string[];
}

// ── Context ───────────────────────────────────────────────────────────

export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentContext {
  runId: string;
  conversationId: string;
  userId?: string;

  system: {
    persona: string;
    rules: string[];
    safety: string[];
  };

  currentMessage: {
    id: string;
    content: string;
    attachments: AttachmentRef[];
  };

  messages: ContextMessage[];
  memories: Array<{
    id: string;
    type: string;
    title: string;
    content: string;
    source: string;
    confidence: number;
    scope?: string;
    scopeId?: string;
    score?: number;
  }>;
  artifacts: Array<{
    id: string;
    name: string;
    type: string;
    summary: string;
  }>;
  toolResults: Array<{
    toolCallId: string;
    summary: string;
    content?: string;
    status: string;
    structured?: Record<string, unknown>;
  }>;
  availableSkills: Array<{
    id: string;
    name: string;
    description: string;
    category: string;
  }>;

  limits: {
    maxTokens: number;
    reservedForOutput: number;
    usedTokensEstimate: number;
  };
  tokenEstimate: number;
  /** Context snapshot for debugging and observability. */
  contextSnapshot?: AgentContextSnapshot;
  /** §P0-3: Phase timing for observability traces (milliseconds). */
  timing?: {
    groupAParallelMs: number;
    summaryGenerationMs: number;
    summaryProcessingMs: number;
    historyProcessingMs: number;
    memorySearchMs: number;
    sourceCompressionMs: number;
    tokenBudgetMs: number;
    contextAssemblyMs: number;
    totalBuildMs: number;
  };
}

/**
 * Context snapshot — records what the model saw during a specific call.
 * Stored in model_calls.metadata.context for debugging and observability.
 */
export interface AgentContextSnapshot {
  chunks: Array<{
    id: string;
    source: string;
    priority: number;
    tokenEstimate: number;
    included: boolean;
    reason?: string;
    /** Trust level of the chunk content (system/user/memory/tool/external). */
    trust?: string;
    /** Source URI for provenance trace (e.g. memory:<id>, tool_call:<id>). */
    sourceUri?: string;
    /** Relevance score from memory/tool search (if applicable). */
    score?: number;
    /** Warning message if the chunk was flagged (e.g. stale summary). */
    warning?: string;
  }>;
  totalTokens: number;
  droppedCount: number;
  /** §P2-1: Source fetch failures recorded for debugging and UI visibility. */
  sourceFailures?: Array<{
    source: string;
    critical: boolean;
    error: string;
  }>;
}

// ── Tool Action ───────────────────────────────────────────────────────

export interface PlannedToolCall {
  id: string;
  skillId: string;
  name: string;
  arguments: Record<string, unknown>;
  permissions: Permission[];
  reason: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresApproval: boolean;
  timeoutMs: number;
  /** Capability-level risk hints from the skill manifest. */
  riskHints?: {
    defaultRisk?: RiskLevel;
    destructiveArgs?: string[];
    externalHosts?: string[];
  };
  /** Capability input JSON Schema for argument validation. */
  inputSchema?: Record<string, unknown>;
  /** Capability output JSON Schema for execution-boundary validation. */
  outputSchema?: Record<string, unknown>;
  /** Structured observation projection hints from the skill manifest. */
  projectionHints?: {
    summaryFields?: string[];
    identityFields?: string[];
    sourceUrlFields?: string[];
    confidenceFields?: string[];
  };
  /** Provenance tracking for each argument (source of the value). */
  argumentSources?: Array<{
    arg: string;
    source: "message" | "attachment" | "memory" | "tool_result" | "plan" | "llm" | "heuristic";
    ref?: string;
  }>;
  /** Audit metadata: planStepId, retrievalReason, repairHistory, etc. (§P0-2). */
  metadata?: Record<string, unknown>;
}

// ── Observation ───────────────────────────────────────────────────────

export interface AgentObservation {
  runId: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactRef[];
  summary: string;
}

/**
 * Agent task state — tracks goal progress across multiple tool iterations.
 * Updated after each tool execution to maintain semantic understanding of
 * what has been accomplished and what remains.
 */
export interface AgentTaskState {
  goal: string;
  completedSteps: string[];
  pendingSteps: string[];
  gatheredFacts: Record<string, unknown>;
  openQuestions: string[];
  iteration: number;
}

/**
 * Conversation summary — rolling compression of older conversation turns.
 * Stored as a memory record (type: "conversation_summary") to replace
 * raw message history when the conversation grows beyond budget limits.
 */
export interface ConversationSummary {
  conversationId: string;
  range: { fromMessageId: string; toMessageId: string };
  userGoals: string[];
  decisions: string[];
  facts: string[];
  preferences: string[];
  toolResults: Array<{
    toolCallId: string;
    skillId: string;
    summary: string;
    resultRef?: string;
  }>;
  attachments: Array<{
    messageId: string;
    name: string;
    type: string;
    url?: string;
  }>;
  openQuestions: string[];
}

// ── Safety ────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type Permission =
  | "filesystem.read"
  | "filesystem.write"
  | "filesystem.delete"
  | "shell.execute"
  | "network.request"
  | "database.read"
  | "database.write"
  | "secret.read"
  | "artifact.write"
  | "memory.write"
  | "external.send";

// ── Component Interfaces ──────────────────────────────────────────────

export interface ContextBuilder {
  build(input: AgentLoopInput, signal: AbortSignal): Promise<AgentContext>;
}

/** Progress emitted during tool execution (§P1-4). */
export interface ToolExecutionProgress {
  phase: "queued" | "running" | "polling" | "completed";
  message: string;
  /** 0-100 progress percentage, when available. */
  percent?: number;
  /** External task ID for async/polling operations. */
  externalTaskId?: string;
}

export interface ExecutionOrchestrator {
  execute(
    input: {
      runId: string;
      context: AgentContext;
      calls: PlannedToolCall[];
      permissionMode?: PermissionMode;
      approvedTools?: Array<{
        toolCallId: string;
        skillId: string;
        arguments: Record<string, unknown>;
        grantedBy?: string;
      }>;
      /** Optional progress callback for content-block status updates (§P1-4). */
      onProgress?: (progress: ToolExecutionProgress) => void;
    },
    signal: AbortSignal,
  ): Promise<AgentObservation>;
  clearSafetyState?(runId: string): void;
}

export interface PermissionPolicy {
  evaluate(input: {
    userId?: string;
    runId: string;
    skillId: string;
    permissions: Permission[];
    arguments: Record<string, unknown>;
    context: AgentContext;
    /** User-selected permission mode from the frontend. */
    permissionMode?: PermissionMode;
    /** Optional capability-level risk hints from the skill manifest. */
    riskHints?: {
      defaultRisk?: RiskLevel;
      destructiveArgs?: string[];
      externalHosts?: string[];
    };
  }): Promise<{
    allowed: boolean;
    requiresApproval: boolean;
    riskLevel: RiskLevel;
    reasons: string[];
  }>;
}

export interface ApprovalGate {
  createApproval(input: {
    runId: string;
    stepId?: string;
    toolCallId?: string;
    title: string;
    description: string;
    riskLevel: RiskLevel;
    requestedAction: {
      skillId: string;
      arguments: Record<string, unknown>;
      permissions: Permission[];
      messageId?: string;
    };
  }): Promise<{ id: string; status: string }>;

  approve(
    approvalId: string,
    decidedBy?: string,
  ): Promise<{
    approvalId: string;
    runId: string;
    decidedBy?: string;
    title?: string;
    riskLevel?: RiskLevel;
    requestedAction?: {
      skillId: string;
      arguments: Record<string, unknown>;
      permissions: Permission[];
      toolCallId?: string;
      messageId?: string;
    };
    messageId?: string;
  }>;
  reject(
    approvalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<{
    approvalId: string;
    runId: string;
    decidedBy?: string;
    reason?: string;
  }>;
}
