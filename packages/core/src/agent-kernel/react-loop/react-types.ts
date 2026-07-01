import type { ChatMessage, ToolCall, ToolDefinition } from "../../llm/llm.types.js";
import type {
  AgentLoopInput,
  ArtifactRef,
  AssistantMessagePart,
  PermissionMode,
  PlannedToolCall,
  ToolCallSummary,
} from "../loop-types.js";

export type { ReactLoopLimits } from "./loop-limits.js";
export { DEFAULT_REACT_LOOP_LIMITS } from "./loop-limits.js";

export type ReactObservationKind =
  | "tool_completed"
  | "tool_failed"
  | "tool_validation_failed"
  | "permission_denied"
  | "approval_rejected"
  | "duplicate_tool_call"
  | "model_protocol_error"
  | "budget_exhausted";

export interface ReactObservation {
  kind: ReactObservationKind;
  toolCallId?: string;
  skillId?: string;
  trusted: boolean;
  displaySummary: string;
  modelContent: string;
  structured?: Record<string, unknown>;
}

export interface ReactModelTurnResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls";
  textPartId?: string;
  firstTokenMs: number;
  modelCallId: string;
  protocolError?: string;
}

export interface RetrievedReactTool {
  id: string;
  score: number;
  reasons: string[];
  definition: ToolDefinition;
}

export interface ReactCheckpoint {
  version: 1;
  runId: string;
  conversationId: string;
  messageId: string;
  iteration: number;
  modelCalls: number;
  transcript: ChatMessage[];
  candidateToolIds: string[];
  pendingToolCalls: PlannedToolCall[];
  artifacts: ArtifactRef[];
  toolCallSummaries: ToolCallSummary[];
  partsSnapshot: AssistantMessagePart[];
  modelId?: "dp" | "seed";
  permissionMode: PermissionMode;
  /**
   * Immutable request metadata needed to reconstruct the same turn after a
   * daemon restart or a human checkpoint. Optional for version-1 checkpoints
   * written before this field was introduced.
   */
  inputSnapshot?: Pick<
    AgentLoopInput,
    "userMessageId" | "userId" | "message" | "mode" | "attachments" | "client"
  >;
  updatedAt: string;
}

export interface ReactLoopTiming {
  toolRetrievalMs: number;
  totalToolExecutionMs: number;
  firstRoundFirstTokenMs: number;
  finalRoundFirstTokenMs: number;
}

export interface ReactLoopCompleted {
  type: "completed";
  messageId: string;
  content: string;
  artifacts: ArtifactRef[];
  toolCalls: ToolCallSummary[];
  checkpoint: ReactCheckpoint;
  timing: ReactLoopTiming;
}

export interface ReactLoopWaitingApproval {
  type: "waiting_approval";
  messageId: string;
  calls: PlannedToolCall[];
  checkpoint: ReactCheckpoint;
  timing: ReactLoopTiming;
}

export interface ReactLoopWaitingUser {
  type: "waiting_user";
  messageId: string;
  question: string;
  missingFields: string[];
  /** §P0: If the LLM already produced a text part that was promoted to
   *  "user_prompt", this is its id. The engine/continuation should avoid
   *  creating a duplicate user_prompt text part when this is set. */
  promptTextPartId?: string;
  checkpoint: ReactCheckpoint;
  timing: ReactLoopTiming;
}

export type ReactLoopResult =
  | ReactLoopCompleted
  | ReactLoopWaitingApproval
  | ReactLoopWaitingUser;

export interface ReactContinuation {
  transcript: ChatMessage[];
  /** Frozen catalog snapshot from the original turn. */
  candidateToolIds?: string[];
  artifacts?: ArtifactRef[];
  toolCalls?: ToolCallSummary[];
  iteration?: number;
  modelCalls?: number;
}
