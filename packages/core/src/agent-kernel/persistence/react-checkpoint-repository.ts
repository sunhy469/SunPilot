import type { RunStateManager } from "../run-state-manager.js";
import type { ReactCheckpoint } from "../react-loop/react-types.js";

export interface ReactCheckpointRepository {
  save(checkpoint: ReactCheckpoint, goal?: string): Promise<void>;
  findByRunId(runId: string): Promise<ReactCheckpoint | undefined>;
}

/** Stores ReAct checkpoints in the durable Run task-state envelope. */
export class RunStateReactCheckpointRepository
implements ReactCheckpointRepository {
  constructor(private readonly runStateManager: RunStateManager) {}

  async save(
    checkpoint: ReactCheckpoint,
    goal = "ReAct run checkpoint",
  ): Promise<void> {
    await this.runStateManager.saveTaskState(checkpoint.runId, {
      goal,
      completedSteps: [],
      pendingSteps: checkpoint.pendingToolCalls.map((call) => call.skillId),
      gatheredFacts: {
        reactCheckpoint: checkpoint,
        approvalMessageId: checkpoint.messageId,
        partsSnapshot: checkpoint.partsSnapshot,
        pendingToolCalls: checkpoint.pendingToolCalls,
      },
      openQuestions: [],
      iteration: checkpoint.iteration,
    });
  }

  async findByRunId(runId: string): Promise<ReactCheckpoint | undefined> {
    const run = await this.runStateManager.getRun(runId);
    return parseReactCheckpoint(run?.taskState?.gatheredFacts.reactCheckpoint);
  }
}

export function parseReactCheckpoint(value: unknown): ReactCheckpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const checkpoint = value as ReactCheckpoint;
  if (
    checkpoint.version !== 1 ||
    typeof checkpoint.runId !== "string" ||
    typeof checkpoint.conversationId !== "string" ||
    typeof checkpoint.messageId !== "string" ||
    !Number.isInteger(checkpoint.iteration) ||
    checkpoint.iteration < 0 ||
    !Number.isInteger(checkpoint.modelCalls) ||
    checkpoint.modelCalls < 0 ||
    !isTranscript(checkpoint.transcript) ||
    !isStringArray(checkpoint.candidateToolIds) ||
    !isPendingToolCalls(checkpoint.pendingToolCalls) ||
    !isArtifacts(checkpoint.artifacts) ||
    !isToolCallSummaries(checkpoint.toolCallSummaries) ||
    !isPartsSnapshot(checkpoint.partsSnapshot) ||
    (checkpoint.modelId !== undefined && !["dp", "seed"].includes(checkpoint.modelId)) ||
    !["ask", "auto", "full"].includes(checkpoint.permissionMode) ||
    !isInputSnapshot(checkpoint.inputSnapshot) ||
    typeof checkpoint.updatedAt !== "string"
  ) {
    return undefined;
  }
  return checkpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isTranscript(value: unknown): boolean {
  return Array.isArray(value) && value.every((message) => {
    if (!isRecord(message) || !["system", "user", "assistant", "tool"].includes(String(message.role))) {
      return false;
    }
    if (typeof message.content !== "string") return false;
    if (message.tool_call_id !== undefined && typeof message.tool_call_id !== "string") return false;
    if (message.role === "tool" && !nonEmptyString(message.tool_call_id)) return false;
    if (message.role !== "tool" && message.tool_call_id !== undefined) return false;
    if (message.tool_calls === undefined) return true;
    return Array.isArray(message.tool_calls) && message.tool_calls.every((call) =>
      isRecord(call) && nonEmptyString(call.id) && call.type === "function" &&
      isRecord(call.function) && nonEmptyString(call.function.name) &&
      typeof call.function.arguments === "string"
    );
  });
}

function isPendingToolCalls(value: unknown): boolean {
  return Array.isArray(value) && value.every((call) =>
    isRecord(call) && nonEmptyString(call.id) && nonEmptyString(call.skillId) &&
    nonEmptyString(call.name) && isRecord(call.arguments) &&
    Array.isArray(call.permissions) && isStringArray(call.permissions) &&
    typeof call.reason === "string" &&
    ["low", "medium", "high", "critical"].includes(String(call.riskLevel)) &&
    typeof call.requiresApproval === "boolean" &&
    typeof call.timeoutMs === "number" && Number.isFinite(call.timeoutMs) &&
    call.timeoutMs > 0 &&
    (call.inputSchema === undefined || isRecord(call.inputSchema)) &&
    (call.outputSchema === undefined || isRecord(call.outputSchema))
  );
}

function isArtifacts(value: unknown): boolean {
  return Array.isArray(value) && value.every((artifact) =>
    isRecord(artifact) && typeof artifact.id === "string" &&
    typeof artifact.name === "string" && typeof artifact.type === "string"
  );
}

function isToolCallSummaries(value: unknown): boolean {
  return Array.isArray(value) && value.every((summary) =>
    isRecord(summary) && typeof summary.id === "string" &&
    typeof summary.skillId === "string" && typeof summary.name === "string" &&
    ["completed", "failed", "cancelled", "timeout"].includes(String(summary.status)) &&
    typeof summary.summary === "string"
  );
}

function isPartsSnapshot(value: unknown): boolean {
  return Array.isArray(value) && value.every((part) => {
    if (!isRecord(part) || !nonEmptyString(part.id)) return false;
    switch (part.type) {
      case "text":
        return typeof part.content === "string" && part.source === "model" &&
          ["streaming", "completed"].includes(String(part.status));
      case "status":
        return typeof part.label === "string" && nonEmptyString(part.runId) &&
          ["running", "completed", "failed"].includes(String(part.status));
      case "tool_use":
        return nonEmptyString(part.toolCallId) && nonEmptyString(part.skillId) &&
          nonEmptyString(part.name) &&
          ["pending", "running", "completed", "failed", "interrupted"].includes(String(part.status));
      case "tool_result":
        return nonEmptyString(part.toolCallId) && nonEmptyString(part.skillId) &&
          typeof part.summary === "string" &&
          ["collapsed", "hidden", "expanded"].includes(String(part.visible));
      case "error":
        return typeof part.message === "string";
      default:
        return false;
    }
  });
}

function isInputSnapshot(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return typeof value.userMessageId === "string" &&
    typeof value.message === "string" &&
    ["chat", "agent"].includes(String(value.mode)) &&
    (value.userId === undefined || typeof value.userId === "string") &&
    Array.isArray(value.attachments) &&
    value.attachments.every((attachment) =>
      isRecord(attachment) && nonEmptyString(attachment.id) &&
      nonEmptyString(attachment.name) && nonEmptyString(attachment.type) &&
      (attachment.url === undefined || typeof attachment.url === "string") &&
      (attachment.dataUrl === undefined || typeof attachment.dataUrl === "string") &&
      (attachment.storageKey === undefined || typeof attachment.storageKey === "string")
    ) &&
    isRecord(value.client) && ["web", "cli", "api"].includes(String(value.client.source)) &&
    (value.client.connectionId === undefined || typeof value.client.connectionId === "string");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
