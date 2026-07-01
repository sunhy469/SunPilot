import type {
  AgentLoopInput,
  AgentLoopResult,
  AssistantMessagePart,
} from "../loop-types.js";
import { AssistantMessageStream } from "../assistant-message-stream.js";
import type {
  AgentLoopEngineDeps,
  ApprovalResumeInput,
} from "../agent-loop-engine.js";
import type {
  ReactCheckpoint,
  ReactLoopResult,
} from "../react-loop/react-types.js";
import { parseReactCheckpoint } from "../persistence/react-checkpoint-repository.js";
import { RUN_PHASE_LABELS } from "./constants.js";
import { ApprovalFlowCoordinator } from "./approval-flow.js";
import { RunOutcomeCoordinator } from "./run-outcomes.js";

/** Re-enters the exact persisted ReAct transcript after a human decision. */
export class ApprovalContinuationCoordinator {
  private readonly runOutcomes: RunOutcomeCoordinator;

  constructor(private readonly deps: AgentLoopEngineDeps) {
    this.runOutcomes = new RunOutcomeCoordinator(deps, () => undefined);
  }

  async continueAfterRejection(
    input: {
      runId: string;
      conversationId: string;
      userId?: string;
      rejectedToolCallId?: string;
      originalMessage: string;
      mode: "chat" | "agent";
      reason?: string;
    },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const run = await this.requireRun(input.runId, "waiting_approval");
    const checkpoint = requireReactCheckpoint(
      run.taskState?.gatheredFacts,
      run.runId,
      run.conversationId,
    );
    const agentInput = buildAgentInput({
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      message: input.originalMessage,
      mode: input.mode,
      modelId: checkpoint.modelId,
      permissionMode: checkpoint.permissionMode,
      checkpoint,
    });
    let stream: AssistantMessageStream | undefined;
    try {
      stream = this.hydrate(checkpoint);
      const context = await this.deps.contextBuilder.build(agentInput, signal);
      for (const call of checkpoint.pendingToolCalls) {
        stream.updateToolUse(call.id, { status: "failed" });
        stream.addToolResult({
          toolCallId: call.id,
          skillId: call.skillId,
          summary: input.reason ?? "用户拒绝了该操作。",
          trust: "trusted",
        });
      }
      completeWaitingStatuses(stream, checkpoint.partsSnapshot, "已拒绝，正在重新规划");
      await this.deps.runStateManager.markStatus(input.runId, "running");
      this.emitRunStarted(input.runId, input.conversationId, "approval_rejected");
      this.deps.traceManager?.startTrace(input.runId, input.conversationId);
      const result = await this.deps.reactLoopRunner.resumeAfterRejection(
        {
          agentInput,
          context,
          checkpoint,
          stream,
          reason: input.reason,
        },
        signal,
      );
      return this.finishOrSuspend(agentInput, context, stream, result, signal);
    } catch (error) {
      return this.handleFailure(agentInput, stream, error, signal);
    } finally {
      this.deps.traceManager?.endTrace(input.runId);
    }
  }

  async resumeApprovedTool(
    approval: ApprovalResumeInput,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const run = await this.requireRun(approval.runId, "waiting_approval");
    const checkpoint = requireReactCheckpoint(
      run.taskState?.gatheredFacts,
      run.runId,
      run.conversationId,
    );
    const conversationId = approval.conversationId ?? run.conversationId;
    const agentInput = buildAgentInput({
      runId: run.runId,
      conversationId,
      message: run.goal ?? approval.title ?? approval.requestedAction.skillId,
      mode: run.mode === "chat" ? "chat" : "agent",
      modelId: checkpoint.modelId,
      permissionMode: checkpoint.permissionMode,
      checkpoint,
    });
    let stream: AssistantMessageStream | undefined;
    try {
      stream = this.hydrate(checkpoint);
      const context = await this.deps.contextBuilder.build(agentInput, signal);
      completeWaitingStatuses(stream, checkpoint.partsSnapshot, "已确认，正在执行");
      await this.deps.runStateManager.markStatus(run.runId, "running");
      this.emitRunStarted(run.runId, conversationId, "approval_approved");
      this.deps.traceManager?.startTrace(run.runId, conversationId);
      const approvedScopes = extractApprovedToolScopes(approval).map((scope) => ({
        ...scope,
        grantedBy: approval.decidedBy ?? "user",
      }));
      const result = await this.deps.reactLoopRunner.resumeAfterApprovedTools(
        {
          agentInput,
          context,
          checkpoint,
          stream,
          approvedTools: approvedScopes,
        },
        signal,
      );
      return await this.finishOrSuspend(
        agentInput,
        context,
        stream,
        result,
        signal,
      );
    } catch (error) {
      return this.handleFailure(agentInput, stream, error, signal);
    } finally {
      this.deps.traceManager?.endTrace(run.runId);
    }
  }

  async resumeWithUserInput(
    input: {
      runId: string;
      conversationId?: string;
      userId?: string;
      userMessageId?: string;
      message: string;
      attachments?: AgentLoopInput["attachments"];
    },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const run = await this.requireRun(input.runId, "waiting_user");
    const checkpoint = requireReactCheckpoint(
      run.taskState?.gatheredFacts,
      run.runId,
      run.conversationId,
    );
    const agentInput = buildAgentInput({
      runId: run.runId,
      conversationId: input.conversationId ?? run.conversationId,
      userId: input.userId,
      userMessageId: input.userMessageId,
      message: input.message,
      mode: run.mode === "chat" ? "chat" : "agent",
      modelId: checkpoint.modelId,
      permissionMode: checkpoint.permissionMode,
      checkpoint,
      attachments: input.attachments ?? [],
    });
    let stream: AssistantMessageStream | undefined;
    try {
      stream = this.hydrate(checkpoint);
      const context = await this.deps.contextBuilder.build(agentInput, signal);
      for (const part of checkpoint.partsSnapshot) {
        if (
          part.type === "status" &&
          part.status === "running" &&
          part.label === "等待你补充信息"
        ) {
          stream.updateStatus(part.id, {
            status: "completed",
            label: "已收到补充信息",
          });
        }
      }
      await this.deps.runStateManager.markStatus(run.runId, "running");
      this.emitRunStarted(run.runId, agentInput.conversationId, "user_input");
      this.deps.traceManager?.startTrace(run.runId, agentInput.conversationId);
      const result = await this.deps.reactLoopRunner.resumeWithUserInput(
        {
          agentInput,
          context,
          checkpoint,
          stream,
          userMessage: input.message,
        },
        signal,
      );
      return this.finishOrSuspend(agentInput, context, stream, result, signal);
    } catch (error) {
      return this.handleFailure(agentInput, stream, error, signal);
    } finally {
      this.deps.traceManager?.endTrace(run.runId);
    }
  }

  async resumeInterrupted(
    input: { runId: string; userId?: string },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const run = await this.requireRun(input.runId, "interrupted");
    const checkpoint = requireReactCheckpoint(
      run.taskState?.gatheredFacts,
      run.runId,
      run.conversationId,
    );
    const agentInput = buildAgentInput({
      runId: run.runId,
      conversationId: run.conversationId,
      userId: input.userId,
      message: run.goal ?? "Resume interrupted ReAct run",
      mode: run.mode === "chat" ? "chat" : "agent",
      modelId: checkpoint.modelId,
      permissionMode: checkpoint.permissionMode,
      checkpoint,
    });
    let stream: AssistantMessageStream | undefined;
    try {
      stream = this.hydrate(checkpoint);
      const context = await this.deps.contextBuilder.build(agentInput, signal);
      await this.deps.runStateManager.markStatus(run.runId, "running");
      this.emitRunStarted(run.runId, run.conversationId, "interrupted_resume");
      this.deps.traceManager?.startTrace(run.runId, run.conversationId);
      const result = await this.deps.reactLoopRunner.resumeInterrupted(
        { agentInput, context, checkpoint, stream },
        signal,
      );
      return this.finishOrSuspend(agentInput, context, stream, result, signal);
    } catch (error) {
      return this.handleFailure(agentInput, stream, error, signal);
    } finally {
      this.deps.traceManager?.endTrace(run.runId);
    }
  }

  private async finishOrSuspend(
    input: AgentLoopInput,
    context: Awaited<ReturnType<AgentLoopEngineDeps["contextBuilder"]["build"]>>,
    stream: AssistantMessageStream,
    result: ReactLoopResult,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    if (result.type === "waiting_approval") {
      return new ApprovalFlowCoordinator(this.deps).runReactApproval(
        input,
        result.calls,
        result.checkpoint,
        stream,
        signal,
      );
    }
    if (result.type === "waiting_user") {
      const part = stream.startTextPart("progress");
      stream.appendText(part.id, result.question);
      stream.completeTextPart(part.id);
      stream.startStatus({
        label: "等待你补充信息",
        metadata: { phase: "queued" },
      });
      const checkpoint: ReactCheckpoint = {
        ...result.checkpoint,
        partsSnapshot: stream.getPartsSnapshot(),
        updatedAt: new Date().toISOString(),
      };
      await stream.persistSnapshot();
      await saveCheckpoint(this.deps, checkpoint);
      await this.deps.eventBus.flush();
      await this.deps.runStateManager.markStatus(input.runId, "waiting_user");
      this.deps.eventBus.emit(
        "agent.clarification.requested",
        {
          runId: input.runId,
          question: result.question,
          missingFields: result.missingFields,
          messageId: checkpoint.messageId,
        },
        { runId: input.runId, conversationId: input.conversationId },
      );
      return {
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId: checkpoint.messageId,
        status: "waiting_user",
        artifacts: checkpoint.artifacts,
        toolCalls: checkpoint.toolCallSummaries,
      };
    }

    const completed = await stream.complete();
    await this.runOutcomes.writeMemories({
      input,
      context,
      responseMessageId: completed.messageId,
      turnCompleted: true,
      observation: result.toolCalls.length > 0
        ? {
            runId: input.runId,
            toolCalls: result.toolCalls,
            artifacts: result.artifacts,
            summary: result.toolCalls.map((call) => call.summary).join("\n"),
          }
        : undefined,
      forceSummary:
        context.messages.length >= 20 ||
        context.limits.usedTokensEstimate / Math.max(1, context.limits.maxTokens) > 0.4,
    });
    await this.deps.runStateManager.markStatus(input.runId, "completed");
    this.deps.eventBus.emit(
      "agent.run.completed",
      {
        runId: input.runId,
        assistantMessageId: completed.messageId,
        artifacts: result.artifacts.map((artifact) => artifact.id),
        toolCalls: result.toolCalls.length,
      },
      { runId: input.runId, conversationId: input.conversationId },
    );
    return {
      runId: input.runId,
      conversationId: input.conversationId,
      assistantMessageId: completed.messageId,
      status: "completed",
      artifacts: result.artifacts,
      toolCalls: result.toolCalls,
    };
  }

  private async handleFailure(
    input: AgentLoopInput,
    stream: AssistantMessageStream | undefined,
    error: unknown,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    if (signal.aborted) {
      if (stream) {
        await stream.complete("cancelled").catch(() => undefined);
      }
      await this.deps.runStateManager.markCancelled(input.runId, "aborted");
      this.deps.eventBus.emit(
        "agent.run.cancelled",
        { runId: input.runId, reason: "aborted" },
        { runId: input.runId, conversationId: input.conversationId },
      );
      return {
        runId: input.runId,
        conversationId: input.conversationId,
        status: "cancelled",
        artifacts: [],
        toolCalls: [],
      };
    }
    if (stream) {
      stream.addError({
        code: "REACT_CONTINUATION_FAILED",
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
      });
      await stream.complete("failed").catch(() => undefined);
    }
    await this.deps.runStateManager.markFailed(input.runId, error);
    const agentError = {
      code: (error as { code?: string }).code ?? "AGENT_INTERNAL_ERROR",
      message: error instanceof Error ? error.message : String(error),
      category: "internal",
      retryable: false,
    };
    this.deps.eventBus.emit(
      "agent.run.failed",
      { runId: input.runId, error: agentError },
      { runId: input.runId, conversationId: input.conversationId },
    );
    this.deps.eventBus.emit(
      "agent.error",
      {
        runId: input.runId,
        conversationId: input.conversationId,
        ...agentError,
        fatal: true,
      },
      { runId: input.runId, conversationId: input.conversationId },
    );
    return {
      runId: input.runId,
      conversationId: input.conversationId,
      status: "failed",
      artifacts: [],
      toolCalls: [],
      error: agentError,
    };
  }

  private hydrate(checkpoint: ReactCheckpoint): AssistantMessageStream {
    if (!this.deps.saveMessage) {
      throw new Error("ReAct continuation requires saveMessage");
    }
    const stream = new AssistantMessageStream({
      runId: checkpoint.runId,
      conversationId: checkpoint.conversationId,
      messageId: checkpoint.messageId,
      eventBus: this.deps.eventBus,
      saveMessage: this.deps.saveMessage,
      initialParts: checkpoint.partsSnapshot,
    });
    stream.start();
    return stream;
  }

  private emitRunStarted(
    runId: string,
    conversationId: string,
    continuation: string,
  ): void {
    this.deps.eventBus.emit(
      "agent.run.started",
      { runId, conversationId, continuation },
      { runId, conversationId },
    );
  }

  private async requireRun(
    runId: string,
    status: "waiting_approval" | "waiting_user" | "interrupted",
  ) {
    const run = await this.deps.runStateManager.getRun(runId);
    if (!run) {
      throw Object.assign(new Error(`Unknown run: ${runId}`), {
        code: "AGENT_RUN_NOT_FOUND",
      });
    }
    if (run.status !== status) {
      throw Object.assign(
        new Error(`Cannot resume run ${runId}; expected ${status}, got ${run.status}`),
        { code: "AGENT_RUN_STATE_CONFLICT" },
      );
    }
    return run;
  }
}

function buildAgentInput(input: {
  runId: string;
  conversationId: string;
  userId?: string;
  userMessageId?: string;
  message: string;
  mode: "chat" | "agent";
  modelId?: "dp" | "seed";
  permissionMode: "ask" | "auto" | "full";
  checkpoint: ReactCheckpoint;
  attachments?: AgentLoopInput["attachments"];
}): AgentLoopInput {
  const snapshot = input.checkpoint.inputSnapshot;
  return {
    runId: input.runId,
    conversationId: input.conversationId,
    userMessageId: input.userMessageId ?? snapshot?.userMessageId ?? input.runId,
    userId: input.userId ?? snapshot?.userId,
    message: input.message,
    mode: input.mode,
    modelId: input.modelId,
    permissionMode: input.permissionMode,
    attachments: structuredClone(input.attachments ?? snapshot?.attachments ?? []),
    client: structuredClone(snapshot?.client ?? { source: "api" }),
  };
}

function requireReactCheckpoint(
  gatheredFacts: Record<string, unknown> | undefined,
  runId: string,
  conversationId: string,
): ReactCheckpoint {
  const checkpoint = gatheredFacts?.reactCheckpoint;
  if (!checkpoint || typeof checkpoint !== "object") {
    throw Object.assign(new Error("Run does not contain a ReAct checkpoint"), {
      code: "AGENT_REACT_CHECKPOINT_MISSING",
    });
  }
  const candidate = parseReactCheckpoint(checkpoint);
  if (!candidate) {
    throw Object.assign(new Error("Run contains an invalid ReAct checkpoint"), {
      code: "AGENT_REACT_CHECKPOINT_INVALID",
    });
  }
  if (candidate.runId !== runId || candidate.conversationId !== conversationId) {
    throw Object.assign(
      new Error("Run contains a ReAct checkpoint owned by a different run or conversation"),
      { code: "AGENT_REACT_CHECKPOINT_OWNERSHIP_MISMATCH" },
    );
  }
  return candidate;
}

function completeWaitingStatuses(
  stream: AssistantMessageStream,
  parts: AssistantMessagePart[],
  label: string,
): void {
  for (const part of parts) {
    if (
      part.type === "status" &&
      part.status === "running" &&
      part.label?.startsWith(RUN_PHASE_LABELS.waiting_approval)
    ) {
      stream.updateStatus(part.id, { status: "completed", label });
    }
  }
}

async function saveCheckpoint(
  deps: AgentLoopEngineDeps,
  checkpoint: ReactCheckpoint,
): Promise<void> {
  await deps.runStateManager.saveTaskState(checkpoint.runId, {
    goal: "ReAct run checkpoint",
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

function extractApprovedToolScopes(approval: ApprovalResumeInput): Array<{
  toolCallId: string;
  skillId: string;
  arguments: Record<string, unknown>;
}> {
  const toolCalls = approval.requestedAction.arguments.toolCalls;
  if (Array.isArray(toolCalls)) {
    return toolCalls.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.id !== "string" ||
        typeof candidate.skillId !== "string" ||
        !candidate.arguments ||
        typeof candidate.arguments !== "object" ||
        Array.isArray(candidate.arguments)
      ) {
        return [];
      }
      return [{
        toolCallId: candidate.id,
        skillId: candidate.skillId,
        arguments: candidate.arguments as Record<string, unknown>,
      }];
    });
  }
  return approval.requestedAction.toolCallId
    ? [{
        toolCallId: approval.requestedAction.toolCallId,
        skillId: approval.requestedAction.skillId,
        arguments: approval.requestedAction.arguments,
      }]
    : [];
}
