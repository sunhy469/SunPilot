import type {
  AgentLoopInput,
  AgentLoopResult,
  Permission,
  PlannedToolCall,
  RiskLevel,
} from "../loop-types.js";
import { AssistantMessageStream } from "../assistant-message-stream.js";
import type { AgentLoopEngineDeps } from "../agent-loop-engine.js";
import type { ReactCheckpoint } from "../react-loop/react-types.js";
import { RUN_PHASE_LABELS } from "./constants.js";
import {
  buildRiskReasons,
  maxRiskLevel,
  summarizeArguments,
} from "./utils.js";

/** Persists and exposes a human approval boundary for a frozen ReAct action. */
export class ApprovalFlowCoordinator {
  constructor(private readonly deps: AgentLoopEngineDeps) {}

  async runReactApproval(
    input: AgentLoopInput,
    calls: PlannedToolCall[],
    checkpoint: ReactCheckpoint,
    stream: AssistantMessageStream,
    _signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    if (calls.length === 0) {
      throw new Error("Cannot suspend an empty approval batch");
    }
    const toolNames = calls.map((call) => call.name).join("、");
    const explanation = stream.startTextPart("progress");
    stream.appendText(
      explanation.id,
      `这个操作需要你的确认：我将调用 ${toolNames}。`,
    );
    stream.completeTextPart(explanation.id);

    for (const call of calls) {
      stream.startStatus({
        label: `${RUN_PHASE_LABELS.waiting_approval}: ${call.name}`,
        toolCallId: call.id,
        metadata: { skillId: call.skillId, phase: "queued" },
      });
      stream.addToolUse({
        toolCallId: call.id,
        skillId: call.skillId,
        name: call.name,
        inputPreview: summarizeArguments(call.arguments),
      });
    }

    const updatedCheckpoint: ReactCheckpoint = {
      ...checkpoint,
      pendingToolCalls: calls,
      partsSnapshot: stream.getPartsSnapshot(),
      updatedAt: new Date().toISOString(),
    };
    await this.deps.runStateManager.saveTaskState(input.runId, {
      goal: "Awaiting approval for ReAct tool action",
      completedSteps: [],
      pendingSteps: calls.map((call) => call.skillId),
      gatheredFacts: {
        reactCheckpoint: updatedCheckpoint,
        approvalMessageId: checkpoint.messageId,
        partsSnapshot: updatedCheckpoint.partsSnapshot,
        pendingToolCalls: calls,
      },
      openQuestions: [],
      iteration: checkpoint.iteration,
    });

    const first = calls[0]!;
    const batchRisk = calls.reduce<RiskLevel>(
      (risk, call) => maxRiskLevel(risk, call.riskLevel),
      "medium",
    );
    await this.requestApproval({
      runId: input.runId,
      conversationId: input.conversationId,
      title: `Approve ${toolNames}`,
      description: `Run ${calls.length} ReAct tool call(s): ${JSON.stringify(
        calls.map((call) => ({
          id: call.id,
          skillId: call.skillId,
          name: call.name,
          arguments: summarizeArguments(call.arguments),
        })),
      )}`,
      riskLevel: batchRisk,
      requestedAction: {
        skillId: first.skillId,
        arguments: {
          toolCalls: calls.map((call) => ({
            id: call.id,
            skillId: call.skillId,
            name: call.name,
            arguments: call.arguments,
          })),
        },
        permissions: [...new Set(calls.flatMap((call) => call.permissions))],
        toolCallId: first.id,
      },
      messageId: checkpoint.messageId,
    });

    return {
      runId: input.runId,
      conversationId: input.conversationId,
      assistantMessageId: checkpoint.messageId,
      status: "waiting_approval",
      artifacts: checkpoint.artifacts,
      toolCalls: checkpoint.toolCallSummaries,
    };
  }

  private async requestApproval(input: {
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
  }): Promise<void> {
    if (this.deps.approvalRequestService) {
      const result = await this.deps.approvalRequestService.requestApproval({
        ...input,
        requestedAction: {
          ...input.requestedAction,
          messageId: input.messageId,
        },
      });
      this.deps.eventBus.publish(result.event);
      return;
    }

    await this.deps.runStateManager.markStatus(
      input.runId,
      "waiting_approval",
      `awaiting approval for ${input.title}`,
    );
    const approval = await this.deps.approvalGate.createApproval({
      runId: input.runId,
      toolCallId: input.requestedAction.toolCallId,
      title: input.title,
      description: input.description,
      riskLevel: input.riskLevel,
      requestedAction: {
        ...input.requestedAction,
        messageId: input.messageId,
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
        messageId: input.messageId,
      },
      { runId: input.runId, conversationId: input.conversationId },
    );
  }
}
