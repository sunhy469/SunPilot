import type { AgentEventBus } from "./agent-event-bus.js";
import { AssistantMessageStream } from "./assistant-message-stream.js";
import type {
  AgentLoopInput,
  AgentLoopResult,
  ApprovalGate,
  ContextBuilder,
  ExecutionOrchestrator,
  Permission,
  RiskLevel,
  SaveMessageFn,
} from "./loop-types.js";
import type { MemoryWriter } from "./memory/memory-types.js";
import type { RepositoryApprovalRequestService } from "./persistence/repository-approval-request-service.js";
import type { ReactLoopRunner } from "./react-loop/react-loop-runner.js";
import type { ReactCheckpoint } from "./react-loop/react-types.js";
import type { RunStateManager } from "./run-state-manager.js";
import type { TraceManager } from "./trace-manager.js";
import type { RepositoryTraceManager } from "./trace-persistence.js";
import { ApprovalContinuationCoordinator } from "./agent-loop-engine/approval-continuation.js";
import { ApprovalFlowCoordinator } from "./agent-loop-engine/approval-flow.js";
import { RunOutcomeCoordinator } from "./agent-loop-engine/run-outcomes.js";
export { RUN_PHASE_LABELS } from "./agent-loop-engine/constants.js";

export interface AgentLoopEngineDeps {
  contextBuilder: ContextBuilder;
  reactLoopRunner: ReactLoopRunner;
  executionOrchestrator: ExecutionOrchestrator;
  approvalGate: ApprovalGate;
  runStateManager: RunStateManager;
  eventBus: AgentEventBus;
  approvalRequestService?: RepositoryApprovalRequestService;
  memoryWriter?: MemoryWriter;
  saveMessage?: SaveMessageFn;
  traceManager?: TraceManager | RepositoryTraceManager;
}

export interface ApprovalResumeInput {
  approvalId: string;
  runId: string;
  conversationId?: string;
  decidedBy?: string;
  title?: string;
  riskLevel?: RiskLevel;
  messageId?: string;
  requestedAction: {
    skillId: string;
    arguments: Record<string, unknown>;
    permissions?: Permission[];
    toolCallId?: string;
  };
}

/**
 * Stable service boundary around the single ReAct Action/Observation loop.
 * Durable lifecycle, streaming and human-in-the-loop suspension live here;
 * semantic next-action decisions live exclusively in ReactLoopRunner.
 */
export class AgentLoopEngine {
  private readonly approvalFlow: ApprovalFlowCoordinator;
  private readonly approvalContinuation: ApprovalContinuationCoordinator;
  private readonly runOutcomes: RunOutcomeCoordinator;

  constructor(private readonly deps: AgentLoopEngineDeps) {
    this.approvalFlow = new ApprovalFlowCoordinator(deps);
    this.approvalContinuation = new ApprovalContinuationCoordinator(deps);
    this.runOutcomes = new RunOutcomeCoordinator(deps, (runId) =>
      this.cleanupRun(runId),
    );
  }

  async run(
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const messageId = `msg_${crypto.randomUUID()}`;
    if (!this.deps.saveMessage) {
      throw Object.assign(
        new Error("ReAct loop requires saveMessage for content-block persistence"),
        { code: "AGENT_STREAM_SAVE_MESSAGE_REQUIRED" },
      );
    }
    this.deps.traceManager?.startTrace(input.runId, input.conversationId);

    const stream = new AssistantMessageStream({
      runId: input.runId,
      conversationId: input.conversationId,
      messageId,
      eventBus: this.deps.eventBus,
      saveMessage: this.deps.saveMessage,
      skipStartedEvents: true,
    });
    this.deps.eventBus.emit(
      "agent.message.started",
      { runId: input.runId, conversationId: input.conversationId, messageId },
      { runId: input.runId, conversationId: input.conversationId },
    );
    stream.start();
    const preparingStatus = stream.startStatus({
      label: "正在思考…",
      metadata: { phase: "running" },
    });

    try {
      await this.deps.runStateManager.markStatus(input.runId, "running");
      this.deps.eventBus.emit(
        "agent.run.started",
        { runId: input.runId, conversationId: input.conversationId },
        { runId: input.runId, conversationId: input.conversationId },
      );
      const contextSpan = this.startSpan(input.runId, "context_building");
      this.deps.eventBus.emit(
        "agent.context.started",
        { runId: input.runId },
        { runId: input.runId, conversationId: input.conversationId },
      );
      const context = await this.deps.contextBuilder.build(input, signal);
      this.deps.eventBus.emit(
        "agent.context.completed",
        {
          runId: input.runId,
          tokenEstimate: context.tokenEstimate,
          included: {
            messages: context.messages.length,
            memories: context.memories.length,
            artifacts: context.artifacts.length,
            toolResults: context.toolResults.length,
          },
        },
        { runId: input.runId, conversationId: input.conversationId },
      );
      contextSpan?.endSpan("Context prepared for ReAct loop", {
        tokenInput: context.tokenEstimate,
        latencyMs: context.timing?.contextAssemblyMs,
      });
      stream.updateStatus(preparingStatus.id, {
        status: "completed",
        label: "正在思考…",
      });

      const result = await this.deps.reactLoopRunner.run(
        { agentInput: input, context, messageId, stream },
        signal,
      );

      if (result.type === "waiting_approval") {
        return await this.approvalFlow.runReactApproval(
          input,
          result.calls,
          result.checkpoint,
          stream,
          signal,
        );
      }
      if (result.type === "waiting_user") {
        const question = stream.startTextPart("progress");
        stream.appendText(question.id, result.question);
        stream.completeTextPart(question.id);
        stream.startStatus({
          label: "等待你补充信息",
          metadata: { phase: "queued" },
        });
        const checkpoint = this.withCurrentParts(result.checkpoint, stream);
        await stream.persistSnapshot();
        await this.saveReactCheckpoint(checkpoint);
        await this.deps.eventBus.flush();
        await this.deps.runStateManager.markStatus(input.runId, "waiting_user");
        this.deps.eventBus.emit(
          "agent.clarification.requested",
          {
            runId: input.runId,
            question: result.question,
            missingFields: result.missingFields,
            messageId,
          },
          { runId: input.runId, conversationId: input.conversationId },
        );
        return {
          runId: input.runId,
          conversationId: input.conversationId,
          assistantMessageId: messageId,
          status: "waiting_user",
          artifacts: checkpoint.artifacts,
          toolCalls: checkpoint.toolCallSummaries,
        };
      }

      const completed = await stream.complete();
      await this.writeMemories(input, context, completed.messageId, result);
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
      this.cleanupRun(input.runId);
      return {
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId: completed.messageId,
        status: "completed",
        artifacts: result.artifacts,
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      if (signal.aborted) {
        try {
          const stopped = stream.startTextPart("final");
          stream.appendText(stopped.id, "已停止。");
          stream.completeTextPart(stopped.id);
          await stream.complete("cancelled");
        } catch {
          // The stream may already be closed.
        }
      } else {
        stream.addError({
          code: "REACT_LOOP_FAILED",
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        });
        await stream.complete("failed").catch(() => undefined);
      }
      return this.runOutcomes.handleLoopError(input, error, signal);
    } finally {
      this.deps.traceManager?.endTrace(input.runId);
    }
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
    const result = await this.approvalContinuation.continueAfterRejection(input, signal);
    this.cleanupIfTerminal(input.runId, result);
    return result;
  }

  async resumeApprovedTool(
    approval: ApprovalResumeInput,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const result = await this.approvalContinuation.resumeApprovedTool(approval, signal);
    this.cleanupIfTerminal(approval.runId, result);
    return result;
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
    const result = await this.approvalContinuation.resumeWithUserInput(input, signal);
    this.cleanupIfTerminal(input.runId, result);
    return result;
  }

  async resumeInterrupted(
    input: { runId: string; userId?: string },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const result = await this.approvalContinuation.resumeInterrupted(input, signal);
    this.cleanupIfTerminal(input.runId, result);
    return result;
  }

  /** Release task-scoped execution grants when an inactive run is terminal. */
  disposeRun(runId: string): void {
    this.cleanupRun(runId);
  }

  private async writeMemories(
    input: AgentLoopInput,
    context: Awaited<ReturnType<ContextBuilder["build"]>>,
    responseMessageId: string,
    result: Extract<
      Awaited<ReturnType<ReactLoopRunner["run"]>>,
      { type: "completed" }
    >,
  ): Promise<void> {
    await this.runOutcomes.writeMemories({
      input,
      context,
      responseMessageId,
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
  }

  private withCurrentParts(
    checkpoint: ReactCheckpoint,
    stream: AssistantMessageStream,
  ): ReactCheckpoint {
    return {
      ...checkpoint,
      partsSnapshot: stream.getPartsSnapshot(),
      updatedAt: new Date().toISOString(),
    };
  }

  private async saveReactCheckpoint(checkpoint: ReactCheckpoint): Promise<void> {
    await this.deps.runStateManager.saveTaskState(checkpoint.runId, {
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

  private cleanupRun(runId: string): void {
    this.deps.executionOrchestrator.clearSafetyState?.(runId);
  }

  private cleanupIfTerminal(runId: string, result: AgentLoopResult): void {
    if (
      result.status === "completed" ||
      result.status === "cancelled" ||
      result.status === "failed"
    ) {
      this.cleanupRun(runId);
    }
  }

  private startSpan(
    runId: string,
    kind: import("./trace-manager.js").SpanKind,
  ) {
    if (!this.deps.traceManager) return null;
    try {
      return this.deps.traceManager.startSpan(runId, kind);
    } catch {
      return null;
    }
  }
}
