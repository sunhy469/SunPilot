import type { AgentEventType } from "@sunpilot/protocol";

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
  /** OSS object key for backend record-keeping, deletion, and re-signing. */
  storageKey?: string;
  /** OSS provider identifier. */
  provider?: "aliyun-oss" | "s3" | "minio";
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
  /** Structured tool result for downstream consumption (reflection, response projection). */
  structured?: Record<string, unknown>;
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
  }>;
  totalTokens: number;
  droppedCount: number;
}

// ── Plan ──────────────────────────────────────────────────────────────

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
  /** Provenance tracking for each argument (source of the value). */
  argumentSources?: Array<{
    arg: string;
    source: "message" | "attachment" | "memory" | "tool_result" | "plan" | "llm" | "heuristic";
    ref?: string;
  }>;
}

export type ToolDecision =
  | { type: "no_tool"; reason: string }
  | { type: "use_tool"; toolCalls: PlannedToolCall[]; reason: string }
  | { type: "ask_clarification"; question: string; reason: string }
  | {
      type: "require_approval";
      approval: { title: string; description: string; riskLevel: string };
      reason: string;
    };

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
}

export interface ExecutionOrchestrator {
  execute(
    input: {
      runId: string;
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      decision: ToolDecision & { type: "use_tool" };
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
    };
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
    },
    signal: AbortSignal,
  ): Promise<{
    messageId: string;
    content: string;
  }>;

  composeFromObservation(
    input: {
      input: AgentLoopInput;
      context: AgentContext;
      observation: AgentObservation;
      reflection?: AgentReflection;
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
