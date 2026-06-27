import type {
  AgentLoopInput,
  AgentLoopResult,
  AgentPlan,
  Permission,
  PlannedToolCall,
  RiskLevel,
  RoutedIntent,
  ToolCallSummary,
  ToolDecision,
} from "../loop-types.js";
import { AssistantMessageStream } from "../assistant-message-stream.js";
import type { AgentLoopEngineDeps, ApprovalResumeInput } from "../agent-loop-engine.js";
import { RUN_PHASE_LABELS } from "./constants.js";
import { intentFromSkillId } from "./utils.js";

/** Owns the two public re-entry paths after a user approval decision. */
export class ApprovalContinuationCoordinator {
  constructor(
    private readonly deps: AgentLoopEngineDeps,
    private readonly restorePlanVersion: (runId: string, version: number) => void,
  ) {}

  /**
   * Continue the agent loop after a tool was rejected with
   * `continue_without_tool` strategy. Skips the rejected tool and
   * proceeds directly to responding, letting the LLM explain the
   * situation to the user.
   */
  async continueAfterRejection(
    input: {
      runId: string;
      conversationId: string;
      userId?: string;
      rejectedToolCallId?: string;
      originalMessage: string;
      mode: "chat" | "agent";
    },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const run = await this.deps.runStateManager.getRun(input.runId);
    if (!run) {
      throw Object.assign(new Error(`Unknown run: ${input.runId}`), {
        code: "AGENT_RUN_NOT_FOUND",
      });
    }

    const agentInput: AgentLoopInput = {
      runId: input.runId,
      conversationId: input.conversationId,
      userMessageId: input.runId,
      userId: input.userId,
      message: input.originalMessage,
      mode: input.mode,
      attachments: [],
      client: { source: "api" },
    };

    try {
      // Rebuild context so the LLM has the full conversation
      const context = await this.deps.contextBuilder.build(agentInput, signal);

      // §Step 1c: When saveMessage is available, use stream to emit rejection
      // as a content-block update on the same assistant message.
      const messageId = `msg_${crypto.randomUUID()}`;
      if (this.deps.saveMessage) {
        const stream = new AssistantMessageStream({
          runId: input.runId,
          conversationId: input.conversationId,
          messageId,
          eventBus: this.deps.eventBus,
          saveMessage: this.deps.saveMessage,

        });
        stream.start();

        if (input.rejectedToolCallId) {
          stream.addToolUse({
            toolCallId: input.rejectedToolCallId,
            skillId: "rejected",
            name: "已拒绝的工具",
          });
          stream.updateToolUse(input.rejectedToolCallId, { status: "failed" });
        }

        // Emit rejection explanation as text (final answer after rejection)
        const textPart = stream.startTextPart("final");
        stream.appendText(
          textPart.id,
          "操作已取消。如果您需要其他帮助，请告诉我。",
        );
        stream.completeTextPart(textPart.id);

        const completed = await stream.complete();

        await this.deps.runStateManager.markStatus(input.runId, "completed");
        this.deps.eventBus.emit(
          "agent.run.completed",
          {
            runId: input.runId,
            assistantMessageId: completed.messageId,
            artifacts: [],
            toolCalls: 0,
          },
          { runId: input.runId, conversationId: input.conversationId },
        );

        return {
          runId: input.runId,
          conversationId: input.conversationId,
          assistantMessageId: completed.messageId,
          status: "completed",
          artifacts: [],
          toolCalls: [],
        };
      }

      // saveMessage is required for content-block streaming — no fallback allowed
      throw Object.assign(
        new Error(
          "AGENT_STREAM_SAVE_MESSAGE_REQUIRED: continueAfterRejection requires saveMessage for content-block streaming. " +
          "The legacy composeFromObservation fallback has been removed.",
        ),
        { code: "AGENT_STREAM_SAVE_MESSAGE_REQUIRED", category: "run_state" },
      );
    } catch (error) {
      if (signal.aborted) {
        await this.deps.runStateManager.markCancelled(input.runId, "aborted");
        return {
          runId: input.runId,
          conversationId: input.conversationId,
          status: "cancelled",
          artifacts: [],
          toolCalls: [],
        };
      }
      throw error;
    }
  }

  /**
   * 审批通过后恢复被暂停的工具执行。
   *
   * 这是 Agent Loop 的"重入点"：
   * 1. 从 runStateManager 获取被暂停的 Run，校验状态为 waiting_approval
   * 2. 重新构建上下文（可能已过时，但保留了审批前的会话状态）
   * 3. 构造人工 Intent 和 ToolDecision（跳过意图路由和工具决策）
   * 4. 直接进入 executeToolDecision 子流程
   */
  async resumeApprovedTool(
    approval: ApprovalResumeInput,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const run = await this.deps.runStateManager.getRun(approval.runId);
    if (!run) {
      throw Object.assign(new Error(`Unknown run: ${approval.runId}`), {
        code: "AGENT_RUN_NOT_FOUND",
      });
    }
    if (run.status !== "waiting_approval") {
      throw Object.assign(
        new Error(
          `Cannot resume approval ${approval.approvalId}; run ${run.runId} is ${run.status}`,
        ),
        { code: "AGENT_RUN_STATE_CONFLICT" },
      );
    }

    const conversationId = approval.conversationId ?? run.conversationId;
    const input: AgentLoopInput = {
      runId: run.runId,
      conversationId,
      userMessageId: approval.approvalId,
      userId: undefined,
      message: run.goal ?? approval.title ?? approval.requestedAction.skillId,
      mode: run.mode === "chat" || run.mode === "agent" ? run.mode : "agent",
      attachments: [],
      client: { source: "api" },
    };

    try {
      const context = await this.deps.contextBuilder.build(input, signal);
      const riskLevel = approval.riskLevel ?? "medium";
      const intent: RoutedIntent = {
        type: intentFromSkillId(approval.requestedAction.skillId),
        confidence: 1,
        requiresPlanning: false,
        requiresTool: true,
        requiresApproval: false,
        riskLevel,
        candidateSkills: [approval.requestedAction.skillId],
        reason: `Approved by ${approval.decidedBy ?? "user"}`,
      };
      const decision: ToolDecision & { type: "use_tool" } = {
        type: "use_tool",
        reason: `Approved approval ${approval.approvalId}`,
        toolCalls: [
          {
            id:
              approval.requestedAction.toolCallId ??
              `tool_${crypto.randomUUID()}`,
            skillId: approval.requestedAction.skillId,
            name: approval.title ?? approval.requestedAction.skillId,
            arguments: approval.requestedAction.arguments,
            permissions: approval.requestedAction.permissions ?? [],
            reason: `Approved approval ${approval.approvalId}`,
            riskLevel,
            requiresApproval: false,
            timeoutMs: 60_000,
          },
        ],
      };

      // Restore plan from snapshot if available (§P0-2: evidence chain continuity)
      let resumePlan: AgentPlan | undefined;
      if (this.deps.planSnapshotRepo) {
        try {
          const snapshots = await this.deps.planSnapshotRepo.listByRunId(
            run.runId,
          );
          const latest = snapshots[snapshots.length - 1];
          if (latest) {
            resumePlan = latest.planJson as unknown as AgentPlan | undefined;
            // Restore version counter so resumed snapshots continue numbering (§P0-2)
            this.restorePlanVersion(run.runId, latest.version);
          }
        } catch {
          // Best effort — continue without plan
        }
      }

      // Resume trace for approval continuation (§P0-2)
      if (this.deps.traceManager) {
        this.deps.traceManager.startTrace(run.runId, run.conversationId);
      }

      // §Step 1c: When a messageId was preserved from the initial approval
      // request, continue the SAME assistant message using content-block stream.
      // Hydrate the stream from the saved parts snapshot so "等待确认" status
      // appears before "已批准" and subsequent tool execution parts.
      if (approval.messageId && this.deps.saveMessage) {
        // Recover parts snapshot and pending tool calls from saved task state
        let hydrateParts: import("../loop-types.js").AssistantMessagePart[] | undefined;
        let gatheredFacts: Record<string, unknown> | undefined;
        try {
          const runState = await this.deps.runStateManager.getRun(run.runId);
          gatheredFacts = runState?.taskState?.gatheredFacts as Record<string, unknown> | undefined;
          if (gatheredFacts?.partsSnapshot) {
            hydrateParts = gatheredFacts.partsSnapshot as import("../loop-types.js").AssistantMessagePart[];
          }
        } catch {
          // Best effort
        }

        const stream = new AssistantMessageStream({
          runId: run.runId,
          conversationId,
          messageId: approval.messageId,
          eventBus: this.deps.eventBus,
          saveMessage: this.deps.saveMessage,

          // §Step 1c: Hydrate stream with saved parts from approval wait
          initialParts: hydrateParts,
        });
        stream.start();

        // §P0-3: Update the original "等待确认" status part to completed
        // The hydrated parts include the "等待确认" status part(s) that were
        // created during the approval request. Mark them as completed now.
        if (hydrateParts) {
          for (const part of hydrateParts) {
            if (part.type === "status" && part.status === "running" && part.label?.startsWith(RUN_PHASE_LABELS.waiting_approval)) {
              stream.updateStatus(part.id, {
                status: "completed",
                label: `已确认: ${part.label.replace(`${RUN_PHASE_LABELS.waiting_approval}: `, "")}`,
              });
            }
          }
        }

        await this.deps.runStateManager.markStatus(run.runId, "executing");

        // §P1-2 fix: Execute approved tool calls DIRECTLY instead of
        // re-calling executeStreaming() which lets the LLM re-decide tools.
        // Recover pending tool calls from the saved task state (saved by
        // runApprovalForToolCalls) and execute each one deterministically.
        stream.startStatus({
          label: `已批准: ${approval.title ?? approval.requestedAction.skillId}`,
          metadata: { phase: "running" },
        });

        // Recover pending tool calls from the approval snapshot
        const pendingCalls = (gatheredFacts?.pendingToolCalls as Array<{
          id: string;
          skillId: string;
          name: string;
          arguments: Record<string, unknown>;
          permissions?: Permission[];
          riskLevel?: RiskLevel;
          timeoutMs?: number;
          inputSchema?: Record<string, unknown>;
          riskHints?: PlannedToolCall["riskHints"];
          projectionHints?: PlannedToolCall["projectionHints"];
          argumentSources?: PlannedToolCall["argumentSources"];
        }> | undefined) ?? [{
          id: approval.requestedAction.toolCallId ?? `tool_${crypto.randomUUID()}`,
          skillId: approval.requestedAction.skillId,
          name: approval.title ?? approval.requestedAction.skillId,
          arguments: approval.requestedAction.arguments,
          permissions: approval.requestedAction.permissions,
        }];

        const allArtifacts: import("../loop-types.js").ArtifactRef[] = [];
        const allSummaries: ToolCallSummary[] = [];

        // Execute each pending tool call directly
        for (const pc of pendingCalls) {
          stream.addToolUse({
            toolCallId: pc.id,
            skillId: pc.skillId,
            name: pc.name,
          });
          stream.updateToolUse(pc.id, { status: "running" });

          const statusPart = stream.startStatus({
            label: `正在调用工具: ${pc.name}`,
            toolCallId: pc.id,
            metadata: { skillId: pc.skillId },
          });

          this.deps.eventBus.emit(
            "agent.tool.started",
            { runId: run.runId, toolCallId: pc.id, skillId: pc.skillId, name: pc.name },
            { runId: run.runId, conversationId },
          );

          try {
            const observation = await this.deps.executionOrchestrator.execute(
              {
                runId: run.runId,
                context,
                intent,
                plan: resumePlan,
                decision: {
                  type: "use_tool",
                  reason: `Approved by ${approval.decidedBy ?? "user"}`,
                  toolCalls: [{
                    id: pc.id,
                    skillId: pc.skillId,
                    name: pc.name,
                    arguments: pc.arguments,
                    permissions: pc.permissions ?? [],
                    reason: `Approved execution`,
                    riskLevel: pc.riskLevel ?? "medium",
                    requiresApproval: false,
                    timeoutMs: pc.timeoutMs ?? 60_000,
                    riskHints: pc.riskHints,
                    inputSchema: pc.inputSchema,
                    projectionHints: pc.projectionHints,
                    argumentSources: pc.argumentSources,
                  }],
                },
              },
              signal,
            );

            for (const summary of observation.toolCalls) {
              allSummaries.push(summary);
              const ok = summary.status === "completed";
              stream.updateStatus(statusPart.id, {
                status: ok ? "completed" : "failed",
                label: ok ? `完成: ${pc.name}` : `失败: ${pc.name}`,
              });
              stream.updateToolUse(summary.id, {
                status: ok ? "completed" : "failed",
              });
              stream.addToolResult({
                toolCallId: summary.id,
                skillId: summary.skillId,
                summary: summary.summary,
                artifactIds: observation.artifacts.map((a) => a.id),
                trust: summary.status === "completed" ? "trusted" : "untrusted",
              });
            }
            allArtifacts.push(...observation.artifacts);
          } catch (err) {
            stream.updateStatus(statusPart.id, {
              status: "failed",
              label: `执行失败: ${pc.name}`,
            });
            stream.updateToolUse(pc.id, { status: "failed" });
            stream.addError({
              message: err instanceof Error ? err.message : String(err),
              code: "APPROVED_TOOL_FAILED",
              recoverable: true,
            });
          }
        }

        // Let the model compose a follow-up narrative after tool execution
        await this.deps.runStateManager.markStatus(run.runId, "responding");
        if (allSummaries.length > 0) {
          const followUpPart = stream.startTextPart("final");
          await this.deps.responseComposer.composeDirect(
            {
              input,
              context: {
                ...context,
                toolResults: [
                  ...context.toolResults,
                  ...allSummaries.map((s) => ({
                    toolCallId: s.id,
                    summary: s.summary,
                    status: s.status,
                  })),
                ],
              },
              intent,
              plan: resumePlan,
              modelId: input.modelId,
              stream: { stream, textPartId: followUpPart.id },
            },
            signal,
          );
          stream.completeTextPart(followUpPart.id);
        }

        const completed = await stream.complete();

        if (this.deps.traceManager) {
          this.deps.traceManager.endTrace(run.runId);
        }

        await this.deps.runStateManager.markStatus(run.runId, "completed");

        this.deps.eventBus.emit(
          "agent.run.completed",
          {
            runId: run.runId,
            assistantMessageId: completed.messageId,
            artifacts: allArtifacts.map((a) => a.id),
            toolCalls: allSummaries.length,
          },
          { runId: run.runId, conversationId },
        );

        return {
          runId: run.runId,
          conversationId,
          assistantMessageId: completed.messageId,
          status: "completed",
          artifacts: allArtifacts,
          toolCalls: allSummaries,
        };
      }

      // All resume paths use content-block stream. messageId and saveMessage
      // are always provided by modern approval flows (runApprovalForToolCalls).
      // No fallback needed.
      throw Object.assign(
        new Error("Approval resume requires messageId and saveMessage"),
        { code: "AGENT_RESUME_MISSING_STREAM_DEPS" },
      );
    } catch (error) {
      if (signal.aborted) {
        await this.deps.runStateManager.markCancelled(
          run.runId,
          "aborted by user",
        );
        this.deps.eventBus.emit(
          "agent.run.cancelled",
          { runId: run.runId, reason: "aborted by user" },
          { runId: run.runId, conversationId },
        );
        if (this.deps.traceManager) {
          this.deps.traceManager.endTrace(run.runId);
        }
        return {
          runId: run.runId,
          conversationId,
          status: "cancelled",
          artifacts: [],
          toolCalls: [],
        };
      }

      const err = error instanceof Error ? error : new Error(String(error));
      const agentError = {
        code: (error as { code?: string }).code ?? "AGENT_INTERNAL_ERROR",
        message: err.message,
        category: (error as { category?: string }).category ?? "internal",
        retryable: (error as { retryable?: boolean }).retryable ?? false,
      };
      await this.deps.runStateManager.markFailed(run.runId, error);
      this.deps.eventBus.emit(
        "agent.run.failed",
        { runId: run.runId, error: agentError },
        { runId: run.runId, conversationId },
      );
      this.deps.eventBus.emit(
        "agent.error",
        {
          runId: run.runId,
          conversationId,
          code: agentError.code,
          message: agentError.message,
          category: agentError.category,
          retryable: agentError.retryable,
        },
        { runId: run.runId, conversationId },
      );
      if (this.deps.traceManager) {
        this.deps.traceManager.endTrace(run.runId);
      }
      return {
        runId: run.runId,
        conversationId,
        status: "failed",
        artifacts: [],
        toolCalls: [],
        error: agentError,
      };
    }
  }
}
