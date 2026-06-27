import type {
  AgentContext,
  AgentLoopInput,
  AgentLoopResult,
  AgentPlan,
  Permission,
  RiskLevel,
  RoutedIntent,
  ToolDecision,
} from "../loop-types.js";
import { AssistantMessageStream } from "../assistant-message-stream.js";
import type { AgentLoopEngineDeps } from "../agent-loop-engine.js";
import { RUN_PHASE_LABELS } from "./constants.js";
import {
  buildRiskReasons,
  maxRiskLevel,
  summarizeArguments,
} from "./utils.js";

/** Owns approval request creation and the persisted stream snapshot used on resume. */
export class ApprovalFlowCoordinator {
  constructor(private readonly deps: AgentLoopEngineDeps) {}

  /**
   * §P1-3: Content-block approval for specific tool calls.
   *
   * Creates a stream with status + text parts showing what needs approval,
   * saves partsSnapshot + pendingToolCall for resume, and returns
   * waiting_approval so the run pauses until the user decides.
   */
  async runApprovalForToolCalls(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    plan: AgentPlan | undefined,
    decision: ToolDecision & { type: "use_tool" },
    messageId: string,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    const stream = new AssistantMessageStream({
      runId,
      conversationId,
      messageId,
      eventBus: this.deps.eventBus,
      saveMessage: this.deps.saveMessage!,
      skipStartedEvents: true,
    });
    stream.start();

    // Emit a text part explaining what needs approval
    const toolNames = decision.toolCalls.map((tc) => tc.name).join("、");
    const textPart = stream.startTextPart("progress");
    stream.appendText(
      textPart.id,
      `这个操作需要你的确认：我将调用 ${toolNames}。`,
    );
    stream.completeTextPart(textPart.id);

    // Emit status parts for each tool needing approval
    for (const tc of decision.toolCalls) {
    stream.startStatus({
      label: `${RUN_PHASE_LABELS.waiting_approval}: ${tc.name}`,
      toolCallId: tc.id,
      metadata: { skillId: tc.skillId, phase: "queued" },
    });
      stream.addToolUse({
        toolCallId: tc.id,
        skillId: tc.skillId,
        name: tc.name,
        inputPreview: summarizeArguments(tc.arguments),
      });
    }

    // §P1-2: Snapshot parts + pending tool calls for resume continuity
    const partsSnapshot = stream.getPartsSnapshot();

    await this.deps.runStateManager.saveTaskState(runId, {
      goal: decision.reason,
      completedSteps: [],
      pendingSteps: decision.toolCalls.map((tc) => tc.skillId),
      gatheredFacts: {
        approvalMessageId: messageId,
        partsSnapshot: partsSnapshot as unknown as Record<string, unknown>,
        pendingToolCalls: decision.toolCalls.map((tc) => ({
          id: tc.id,
          skillId: tc.skillId,
          name: tc.name,
          arguments: tc.arguments,
          permissions: tc.permissions,
          riskLevel: tc.riskLevel,
          timeoutMs: tc.timeoutMs,
          inputSchema: tc.inputSchema,
          riskHints: tc.riskHints,
          projectionHints: tc.projectionHints,
          argumentSources: tc.argumentSources,
        })),
      },
      openQuestions: [],
      iteration: 0,
    }).catch(() => { /* Best effort */ });

    // Request approval for each tool call
    for (const tc of decision.toolCalls) {
      await this.requestApprovalWithMessageId({
        runId,
        conversationId,
        title: `Approve ${tc.name}`,
        description: `Run tool ${tc.name} with arguments: ${JSON.stringify(summarizeArguments(tc.arguments))}`,
        riskLevel: maxRiskLevel(tc.riskLevel, "medium"),
        requestedAction: {
          skillId: tc.skillId,
          arguments: tc.arguments,
          permissions: tc.permissions,
          toolCallId: tc.id,
        },
        messageId,
      });
    }

    // Stream is NOT completed — it will be hydrated on resume

    return {
      runId,
      conversationId,
      status: "waiting_approval",
      artifacts: [],
      toolCalls: [],
    };
  }

  /** Approval-required path using stream for status display (§Step 1b). */
  async runApprovalWithStream(
    input: AgentLoopInput,
    decision: ToolDecision & { type: "require_approval" },
    messageId: string,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    const saveMessage = this.deps.saveMessage;
    if (saveMessage) {
      const stream = new AssistantMessageStream({
        runId,
        conversationId,
        messageId,
        eventBus: this.deps.eventBus,
        saveMessage,
        skipStartedEvents: true,
      });
      stream.start();
      stream.startStatus({
      label: `${RUN_PHASE_LABELS.waiting_approval}: ${decision.approval.title}`,
      metadata: { phase: "queued" },
    });

      // §Step 1b: Snapshot current parts for resume continuity.
      // The stream is NOT completed — events are live-emitted via WebSocket.
      // On resume, a new stream will be hydrated from this snapshot.
      const partsSnapshot = stream.getPartsSnapshot();

      await this.deps.runStateManager.saveTaskState(runId, {
        goal: decision.approval.title,
        completedSteps: [],
        pendingSteps: [],
        gatheredFacts: {
          approvalMessageId: messageId,
          partsSnapshot: partsSnapshot as unknown as Record<string, unknown>,
        },
        openQuestions: [],
        iteration: 0,
      }).catch(() => {
        // Best effort
      });
    }

    // §Step 1b: Store messageId so resumeApprovedTool can hydrate and continue.
    await this.requestApprovalWithMessageId({
      runId,
      conversationId,
      title: decision.approval.title,
      description: decision.approval.description,
      riskLevel: decision.approval.riskLevel as RiskLevel,
      requestedAction: {
        // require_approval decisions carry intent-level info (title/description);
        // the concrete tool + arguments are determined post-approval.
        skillId: (decision.approval as { skillId?: string }).skillId ?? decision.approval.title,
        arguments: { title: decision.approval.title, description: decision.approval.description },
        permissions: [],
      },
      messageId,
    });

    return {
      runId,
      conversationId,
      status: "waiting_approval",
      artifacts: [],
      toolCalls: [],
    };
  }

  /**
   * Request approval with messageId stored for stream continuity (§P1-2).
   * Mirrors requestApproval() but passes messageId through to the approval
   * record so resumeApprovedTool can continue the same assistant message.
   */
  private async requestApprovalWithMessageId(input: {
    runId: string;
    conversationId: string;
    title: string;
    description: string;
    riskLevel: RiskLevel;
    requestedAction: {
      skillId: string;
      arguments: Record<string, unknown>;
      permissions: Permission[];
      toolCallId?: string;
    };
    messageId: string;
  }): Promise<{ id: string; status: string }> {
    if (this.deps.approvalRequestService) {
      const result =
        await this.deps.approvalRequestService.requestApproval({
          ...input,
          requestedAction: {
            ...input.requestedAction,
            messageId: input.messageId,
          },
        });
      this.deps.eventBus.publish(result.event);
      return result.approval;
    }

    await this.deps.runStateManager.markStatus(
      input.runId,
      "waiting_approval",
      `awaiting approval for ${input.title}`,
    );
    // Store messageId in approval metadata for resume
    const approval = await this.deps.approvalGate.createApproval({
      runId: input.runId,
      title: input.title,
      description: input.description,
      riskLevel: input.riskLevel,
      requestedAction: {
        ...input.requestedAction,
        // §P1-2: Embed messageId so resume knows which message to continue
        messageId: input.messageId,
      } as unknown as {
        skillId: string;
        arguments: Record<string, unknown>;
        permissions: Permission[];
      },
    });
    this.deps.eventBus.emit(
      "agent.approval.required",
      {
        runId: input.runId,
        approvalId: approval.id,
        title: input.title,
        description: input.description,
        riskLevel: input.riskLevel,
        skillId: input.requestedAction.skillId,
        argumentsPreview: summarizeArguments(input.requestedAction.arguments),
        reasons: buildRiskReasons(input.riskLevel, input.requestedAction),
        // §P1-2: Include messageId in the event for frontend tracking
        messageId: input.messageId,
      },
      { runId: input.runId, conversationId: input.conversationId },
    );
    return approval;
  }
}
