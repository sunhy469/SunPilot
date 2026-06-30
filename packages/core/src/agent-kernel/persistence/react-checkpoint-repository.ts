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
    !Array.isArray(checkpoint.transcript) ||
    !Array.isArray(checkpoint.candidateToolIds) ||
    !Array.isArray(checkpoint.pendingToolCalls) ||
    !Array.isArray(checkpoint.artifacts) ||
    !Array.isArray(checkpoint.toolCallSummaries) ||
    !Array.isArray(checkpoint.partsSnapshot) ||
    !["ask", "auto", "full"].includes(checkpoint.permissionMode) ||
    typeof checkpoint.updatedAt !== "string"
  ) {
    return undefined;
  }
  return checkpoint;
}
