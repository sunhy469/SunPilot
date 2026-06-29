import type { ChatMessage, ToolCall, ToolDefinition } from "../../llm/llm.types.js";
import type {
  ArtifactRef,
  AssistantMessagePart,
  PermissionMode,
  PlannedToolCall,
  ToolCallSummary,
} from "../loop-types.js";

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
  updatedAt: string;
}

export interface ReactLoopLimits {
  maxToolRounds: number;
  maxModelCalls: number;
  maxWallClockMs: number;
  maxRepeatedToolCalls: number;
  maxObservationChars: number;
  toolCatalogLimit: number;
}

export const DEFAULT_REACT_LOOP_LIMITS: ReactLoopLimits = {
  maxToolRounds: 8,
  maxModelCalls: 10,
  maxWallClockMs: 10 * 60_000,
  maxRepeatedToolCalls: 1,
  maxObservationChars: 8_000,
  toolCatalogLimit: 12,
};

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
