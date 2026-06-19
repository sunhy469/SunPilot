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
  setRichCards(cards: Array<{ type: string; title?: string; data: Record<string, unknown> }>): void;
  complete(): Promise<{
    messageId: string;
    content: string;
    parts: AssistantMessagePart[];
  }>;
}

// ── Agent Loop ────────────────────────────────────────────────────────

export type AgentLoopStatus =
  | "created"
  | "context_building"
  | "intent_routing"
  | "planning"
  | "tool_deciding"
  | "waiting_approval"
  | "executing"
  | "observing"
  | "reflecting"
  | "responding"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  /** Structured tool result for downstream consumption (reflection, response projection). */
  structured?: Record<string, unknown>;
  /** Model-facing observation derived from the full tool output (§P0-2).
   *  When set, injectStreamingToolResults uses this instead of summary.
   *  Generated by ToolResultProjection from content + structured fields. */
  modelObservation?: string;
  /** Audit metadata propagated from PlannedToolCall (§P0-2). */
  metadata?: Record<string, unknown>;
}

// ── Intent ────────────────────────────────────────────────────────────

export type IntentType =
  | "casual_chat"
  | "question_answering"
  | "project_analysis"
  | "code_generation"
  | "code_modification"
  | "file_operation"
  | "shell_operation"
  | "automation_execution"
  | "artifact_generation"
  | "memory_update"
  | "diagnostics"
  | "use_skill"
  | "unknown";

export interface RoutedIntent {
  type: IntentType;
  confidence: number;
  requiresPlanning: boolean;
  requiresTool: boolean;
  requiresApproval: boolean;
  riskLevel: "low" | "medium" | "high" | "critical";
  candidateSkills: string[];
  reason: string;
  /** Trace/debug metadata for the routing decision (§P2). */
  trace?: {
    /** "real" | "lexical_fallback" | "none" */
    embeddingMode?: string;
    /** Top embedding similarity score. */
    embeddingTopScore?: number;
    /** Number of skills considered in embedding pass. */
    embeddingCandidateCount?: number;
    /** Whether the intent was determined by form-match rules. */
    formMatch?: boolean;
  };
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
    memorySearchMs: number;
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
}

// ── Plan ──────────────────────────────────────────────────────────────

export type AgentPlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "skipped"
  | "waiting_approval"
  | "needs_clarification"
  | "verified"
  | "failed_retryable"
  | "failed_terminal";

export interface AgentPlanStepCompletionEvidence {
  /** Tool call ID that executed this step. */
  toolCallId?: string;
  /** Summary of the tool result. */
  toolResultSummary?: string;
  /** Whether the user explicitly confirmed this step. */
  userConfirmation?: boolean;
  /** Artifact IDs generated by this step. */
  artifactIds?: string[];
  /** File paths generated or modified. */
  generatedFiles?: string[];
  /** When the step was completed. */
  completedAt?: string;
}

export interface AgentPlanStep {
  id: string;
  title: string;
  description: string;
  type: "reasoning" | "tool" | "automation" | "approval" | "response";
  skillId?: string;
  dependsOn: string[];
  input?: Record<string, unknown>;
  expectedOutput?: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  /** Current step execution status. */
  status: AgentPlanStepStatus;
  /** Completion evidence — traces step completion to specific artifacts and tool calls (§1 of architecture next steps). */
  completionEvidence?: AgentPlanStepCompletionEvidence;
  /** When the step was last updated. */
  updatedAt?: string;
}

export interface AgentPlan {
  id: string;
  runId: string;
  goal: string;
  summary: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  steps: AgentPlanStep[];
  expectedArtifacts: ExpectedArtifact[];
  requiresApproval: boolean;
}

export interface ExpectedArtifact {
  id: string;
  type: string;
  title: string;
  description?: string;
}

// ── Tool Decision ─────────────────────────────────────────────────────

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
  /** Response projection hints from skill manifest (§P2-9). */
  projectionHints?: {
    summaryFields?: string[];
    identityFields?: string[];
    sourceUrlFields?: string[];
    confidenceFields?: string[];
    /** §P1-4: When true, the tool output IS the final answer.
     *  The agent loop skips the second LLM round and emits the
     *  tool result directly as a final text part. */
    outputIsFinal?: boolean;
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

export type ToolDecision =
  | {
      type: "no_tool";
      reason: string;
      /** Trace metadata for debugging tool selection (§P2). */
      decisionPath?: string;
      retrievalTopK?: number;
      retrievalCandidateCount?: number;
      retrievalFallback?: boolean;
    }
  | {
      type: "use_tool";
      toolCalls: PlannedToolCall[];
      reason: string;
      /** Trace metadata for debugging tool selection (§P2). */
      decisionPath?: string;
      retrievalTopK?: number;
      retrievalCandidateCount?: number;
      retrievalFallback?: boolean;
    }
  | {
      type: "ask_clarification";
      question: string;
      reason: string;
      decisionPath?: string;
      retrievalTopK?: number;
      retrievalCandidateCount?: number;
      retrievalFallback?: boolean;
    }
  | {
      type: "require_approval";
      approval: { title: string; description: string; riskLevel: string };
      reason: string;
      decisionPath?: string;
      retrievalTopK?: number;
      retrievalCandidateCount?: number;
      retrievalFallback?: boolean;
    };

// ── Preliminary Inference (parallel with context building) ──────────

/** Result of the preliminary LLM inference that runs in parallel with
 *  context building. The pre-inference uses only the user message +
 *  system prompt (no context), generating a structured JSON routing hint
 *  (not user-visible text) and extracting tool-matching hints for faster
 *  downstream routing. §P2: Text output is internal-only — it is never
 *  written to the user-facing stream. */
export interface PreliminaryInferenceResult {
  /** Pre-inference text — internal routing hint only (§P2). */
  text: string;
  /** Tool-matching hints extracted from the pre-inference output,
   *  injected into decideTools() as prioritySkills. */
  toolHints?: Array<{
    skillId: string;
    reason: string;
    argumentsHint?: Record<string, unknown>;
  }>;
}

// ── Observation ───────────────────────────────────────────────────────

export interface AgentObservation {
  runId: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactRef[];
  summary: string;
}

export interface AgentReflection {
  goalAchieved: boolean;
  confidence: number;
  summary: string;
  nextAction?: "continue" | "respond" | "ask_user";
  missingInfo?: string[];
  nextToolCandidates?: Array<{
    skillId: string;
    reason: string;
    argumentsHint?: Record<string, unknown>;
  }>;
  stopReason?:
    | "goal_achieved"
    | "needs_user"
    | "max_iterations"
    | "tool_failed"
    | "no_tool_available";
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

export interface IntentRouter {
  route(context: AgentContext, signal: AbortSignal): Promise<RoutedIntent>;
}

export interface Planner {
  createPlan(
    context: AgentContext,
    intent: RoutedIntent,
    signal: AbortSignal,
  ): Promise<AgentPlan>;
}

export interface ToolDecisionEngine {
  decide(
    input: {
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      previousObservation?: AgentObservation;
      /** Reflection-suggested tools to prioritize in this round.
       *  When present, these are tried first before normal candidate matching.
       *  Each entry may include an argumentsHint for the argument builder. */
      prioritySkills?: Array<{
        skillId: string;
        reason: string;
        argumentsHint?: Record<string, unknown>;
      }>;
    },
    signal: AbortSignal,
  ): Promise<ToolDecision>;

  /** LLM native function calling loop — interleaves text + tool calls. */
  executeStreaming(
    input: {
      runId: string;
      conversationId: string;
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      messageId?: string;
      modelId?: "dp" | "seed";
      /** User-selected permission mode for tool execution safety checks. */
      permissionMode?: "ask" | "auto" | "full";
      prioritySkills?: Array<{
        skillId: string;
        reason: string;
        argumentsHint?: Record<string, unknown>;
      }>;
      /** Optional stream for content-block parts emission (§Phase 3). */
      stream?: IAssistantMessageStream;
    },
    signal: AbortSignal,
  ): Promise<{
    messageId: string;
    content: string;
    artifacts: ArtifactRef[];
    toolCalls: ToolCallSummary[];
    /** §P0-7: Phase timing metrics for trace observability (milliseconds). */
    timing: {
      toolRetrievalMs: number;
      totalToolExecutionMs: number;
      firstRoundFirstTokenMs: number;
      finalRoundFirstTokenMs: number;
    };
  }>;
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
      intent: RoutedIntent;
      plan?: AgentPlan;
      decision: ToolDecision & { type: "use_tool" };
      /** Optional progress callback for content-block status updates (§P1-4). */
      onProgress?: (progress: ToolExecutionProgress) => void;
    },
    signal: AbortSignal,
  ): Promise<AgentObservation>;
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

export interface ResponseComposer {
  composeDirect(
    input: {
      input: AgentLoopInput;
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      modelId?: "dp" | "seed";
      /** Optional stream + textPartId for content-block parts (§P0-1). */
      stream?: {
        stream: IAssistantMessageStream;
        textPartId: string;
      };
    },
    signal: AbortSignal,
  ): Promise<{
    messageId: string;
    content: string;
  }>;

  composeClarification(input: {
    input: AgentLoopInput;
    question: string;
    reason: string;
  }): Promise<{
    messageId: string;
    content: string;
  }>;
}

export interface ReflectionEngine {
  reflect(
    input: {
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      observation: AgentObservation;
      /** Accumulated task state across iterations for goal-progress tracking. */
      taskState?: AgentTaskState;
    },
    signal: AbortSignal,
  ): Promise<AgentReflection>;
}
