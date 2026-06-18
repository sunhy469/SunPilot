/**
 * Agent event types — the canonical event vocabulary for the Agent Runtime.
 * All chat, run, tool, approval, and response events use the `agent.*` namespace.
 */

export const AGENT_EVENT_TYPES = [
  // Run lifecycle
  "agent.run.created",
  "agent.run.started",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.cancelled",
  "agent.run.interrupted",
  // Context
  "agent.context.started",
  "agent.context.completed",
  // Intent
  "agent.intent.detected",
  // Planning
  "agent.plan.created",
  "agent.plan.warnings",
  "agent.plan.validated",
  "agent.plan.revised",
  // Tool
  "agent.tool.selected",
  "agent.tool.started",
  "agent.tool.delta",
  "agent.tool.completed",
  "agent.tool.failed",
  "agent.tool_argument.generated",
  "agent.tool_argument.validation_failed",
  // Approval
  "agent.approval.required",
  "agent.approval.approved",
  "agent.approval.rejected",
  "agent.approval.expired",
  // Artifact & Memory
  "agent.artifact.created",
  "agent.memory.written",
  // Model
  "agent.model.started",
  "agent.model.delta",
  "agent.model.completed",
  "agent.model.failed",
  // Response
  "agent.response.started",
  "agent.response.delta",
  "agent.response.completed",
  "agent.clarification.requested",
  // Error
  "agent.error",
  // Message content-block events (§Phase 1 of streaming refactoring)
  "agent.message.started",
  "agent.message.part.started",
  "agent.message.part.delta",
  "agent.message.part.updated",
  "agent.message.completed",
  // Safety (§P0-3)
  "agent.safety.injection_detected",
  "agent.safety.sandbox_denied",
  "agent.safety.scope_reauth_required",
] as const;

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

/** Base event envelope sent over WebSocket and persisted to the events table. */
export interface AgentEventEnvelope {
  eventId: string;
  sequence: number;
  runId?: string;
  conversationId?: string;
  type: AgentEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── Payload types per event ──────────────────────────────────────────

export interface AgentRunCreatedPayload {
  runId: string;
  conversationId: string;
  mode: string;
  goal?: string;
}

export interface AgentRunStartedPayload {
  runId: string;
}

export interface AgentRunCompletedPayload {
  runId: string;
  assistantMessageId?: string;
  artifacts: string[];
  toolCalls: number;
}

export interface AgentRunFailedPayload {
  runId: string;
  error: {
    code: string;
    message: string;
    category?: string;
    retryable?: boolean;
  };
}

export interface AgentRunCancelledPayload {
  runId: string;
  reason?: string;
}

export interface AgentRunInterruptedPayload {
  runId: string;
  reason?: string;
}

export interface AgentContextStartedPayload {
  runId: string;
}

export interface AgentContextCompletedPayload {
  runId: string;
  tokenEstimate: number;
  included: {
    messages: number;
    memories: number;
    artifacts: number;
    toolResults: number;
  };
  excluded?: {
    memories?: number;
    reason?: string;
  };
}

export interface AgentIntentDetectedPayload {
  runId: string;
  intent: string;
  confidence: number;
  candidateSkills: string[];
}

export interface AgentPlanCreatedPayload {
  runId: string;
  plan: {
    id: string;
    goal: string;
    summary: string;
    steps: number;
  };
}

export interface AgentToolSelectedPayload {
  runId: string;
  toolCallId: string;
  skillId: string;
  name: string;
  riskLevel: string;
}

export interface AgentToolStartedPayload {
  runId: string;
  toolCallId: string;
  skillId: string;
  name: string;
}

export interface AgentToolDeltaPayload {
  runId: string;
  toolCallId: string;
  delta: string;
}

export interface AgentToolCompletedPayload {
  runId: string;
  toolCallId: string;
  skillId: string;
  summary: string;
  artifacts: string[];
}

export interface AgentToolFailedPayload {
  runId: string;
  toolCallId: string;
  skillId: string;
  name?: string;
  error: {
    code: string;
    message: string;
  };
}

export interface AgentToolArgumentGeneratedPayload {
  runId: string;
  toolCallId: string;
  skillId: string;
  sources: Array<{
    arg: string;
    source: string;
    ref?: string;
  }>;
}

export interface AgentToolArgumentValidationFailedPayload {
  runId: string;
  toolCallId: string;
  skillId: string;
  name?: string;
  validationErrors: string[];
  /** The original arguments that failed validation. */
  failedArguments: Record<string, unknown>;
  /** The schema used for validation. */
  schema?: Record<string, unknown>;
}

export interface AgentApprovalRequiredPayload {
  runId: string;
  approvalId: string;
  title: string;
  description?: string;
  riskLevel: string;
  skillId?: string;
  argumentsPreview?: Record<string, unknown>;
  reasons?: string[];
}

export interface AgentApprovalApprovedPayload {
  runId: string;
  approvalId: string;
  decidedBy?: string;
}

export interface AgentApprovalRejectedPayload {
  runId: string;
  approvalId: string;
  decidedBy?: string;
  reason?: string;
}

export interface AgentArtifactCreatedPayload {
  runId: string;
  artifactId: string;
  name: string;
  type: string;
  version?: number;
}

export interface AgentMemoryWrittenPayload {
  runId: string;
  memoryId: string;
  type: string;
  scope: string;
}

export interface AgentModelStartedPayload {
  runId: string;
  modelCallId: string;
  provider: string;
  model: string;
}

export interface AgentModelDeltaPayload {
  runId: string;
  modelCallId: string;
  delta: string;
}

export interface AgentModelCompletedPayload {
  runId: string;
  modelCallId: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentModelFailedPayload {
  runId: string;
  modelCallId: string;
  error: {
    code: string;
    message: string;
    category?: string;
    retryable?: boolean;
  };
}

export interface AgentResponseStartedPayload {
  runId: string;
  messageId: string;
}

export interface AgentResponseDeltaPayload {
  runId: string;
  conversationId: string;
  messageId: string;
  delta: string;
}

export interface AgentResponseCompletedPayload {
  runId: string;
  conversationId: string;
  messageId: string;
}

export interface AgentClarificationRequestedPayload {
  runId: string;
  conversationId?: string;
  messageId: string;
  question: string;
  reason?: string;
}

export interface AgentErrorPayload {
  runId?: string;
  conversationId?: string;
  code: string;
  message: string;
  category?: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

// ── Message content-block event payloads (§Phase 1) ────────────────

export interface AgentMessageStartedPayload {
  runId: string;
  conversationId: string;
  messageId: string;
}

export interface AgentMessagePartStartedPayload {
  runId: string;
  conversationId: string;
  messageId: string;
  part: {
    id: string;
    type: string;
    content?: string;
    label?: string;
    status?: string;
    toolCallId?: string;
    skillId?: string;
    name?: string;
    runId?: string;
    createdAt: string;
    [key: string]: unknown;
  };
}

export interface AgentMessagePartDeltaPayload {
  runId: string;
  conversationId: string;
  messageId: string;
  partId: string;
  delta: string;
}

export interface AgentMessagePartUpdatedPayload {
  runId: string;
  conversationId: string;
  messageId: string;
  partId: string;
  patch: {
    status?: string;
    label?: string;
    content?: string;
    completedAt?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface AgentMessageCompletedPayload {
  runId: string;
  conversationId: string;
  messageId: string;
  content: string;
  parts: Array<{
    id: string;
    type: string;
    [key: string]: unknown;
  }>;
}

// ── Safety event payloads (§P0-3) ───────────────────────────────────

export interface AgentSafetyInjectionDetectedPayload {
  runId: string;
  conversationId?: string;
  toolCallId?: string;
  source: "tool_result" | "web_content" | "attachment" | "user_message";
  matches: Array<{
    category: string;
    severity: string;
    explanation: string;
  }>;
  blocked: boolean;
  contentSnippet: string;
}

export interface AgentSafetySandboxDeniedPayload {
  runId: string;
  conversationId?: string;
  toolCallId: string;
  skillId: string;
  operation: string;
  reason: string;
  mode: string;
  /** Whether the agent can suggest alternatives. */
  recoverable: boolean;
}

export interface AgentSafetyScopeReauthRequiredPayload {
  runId: string;
  conversationId?: string;
  toolCallId: string;
  skillId: string;
  reason: string;
  previousArgs?: Record<string, unknown>;
  newArgs?: Record<string, unknown>;
  diffSummary?: string;
}
