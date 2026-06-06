import type { AgentEventBus } from "./agent-event-bus.js";
import type { RepositoryApprovalRequestService } from "./persistence/repository-approval-request-service.js";
import type {
  AgentLoopInput,
  AgentLoopResult,
  AgentContext,
  AgentPlan,
  RoutedIntent,
  Permission,
  RiskLevel,
  ToolDecision,
  ApprovalGate,
  ContextBuilder,
  ExecutionOrchestrator,
  IntentRouter,
  PermissionPolicy,
  Planner,
  ReflectionEngine,
  ResponseComposer,
  ToolDecisionEngine,
} from "./loop-types.js";
import type { RunStateManager } from "./run-state-manager.js";
import type { MemoryWriter } from "./memory/memory-types.js";

export interface AgentLoopEngineDeps {
  contextBuilder: ContextBuilder;
  intentRouter: IntentRouter;
  planner: Planner;
  toolDecisionEngine: ToolDecisionEngine;
  executionOrchestrator: ExecutionOrchestrator;
  permissionPolicy: PermissionPolicy;
  approvalGate: ApprovalGate;
  reflectionEngine: ReflectionEngine;
  responseComposer: ResponseComposer;
  runStateManager: RunStateManager;
  eventBus: AgentEventBus;
  approvalRequestService?: RepositoryApprovalRequestService;
  memoryWriter?: MemoryWriter;
}

export interface ApprovalResumeInput {
  approvalId: string;
  runId: string;
  conversationId?: string;
  decidedBy?: string;
  title?: string;
  riskLevel?: RiskLevel;
  requestedAction: {
    skillId: string;
    arguments: Record<string, unknown>;
    permissions?: Permission[];
    toolCallId?: string;
  };
}

/**
 * AgentLoopEngine — the central state machine that runs every user interaction
 * through the full Agent Loop instead of a simple LLM call.
 *
 * Full loop per architecture doc §9:
 *   created → context_building → intent_routing → (planning?) →
 *   tool_deciding → (executing → observing → reflecting)? → responding → completed
 *
 * The engine is transport-agnostic. It receives an AgentLoopInput and
 * returns an AgentLoopResult. The daemon layer handles WebSocket/REST wiring.
 */
export class AgentLoopEngine {
  constructor(private readonly deps: AgentLoopEngineDeps) {}

  async run(
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    try {
      // ── Step 1: Context Building ──────────────────────────────────
      await this.deps.runStateManager.markStatus(runId, "context_building");
      this.deps.eventBus.emit(
        "agent.context.started",
        { runId },
        { runId, conversationId },
      );

      const context = await this.deps.contextBuilder.build(input, signal);

      this.deps.eventBus.emit(
        "agent.context.completed",
        {
          runId,
          tokenEstimate: context.tokenEstimate,
          included: {
            messages: context.messages.length,
            memories: context.memories.length,
            artifacts: context.artifacts.length,
            toolResults: context.toolResults.length,
          },
        },
        { runId, conversationId },
      );

      // ── Step 2: Intent Routing ────────────────────────────────────
      await this.deps.runStateManager.markStatus(runId, "intent_routing");
      const intent = await this.deps.intentRouter.route(context, signal);

      this.deps.eventBus.emit(
        "agent.intent.detected",
        {
          runId,
          intent: intent.type,
          confidence: intent.confidence,
          candidateSkills: intent.candidateSkills,
        },
        { runId, conversationId },
      );

      // ── Step 3: Planning (if needed) ──────────────────────────────
      let plan;
      if (intent.requiresPlanning) {
        await this.deps.runStateManager.markStatus(runId, "planning");
        plan = await this.deps.planner.createPlan(context, intent, signal);

        this.deps.eventBus.emit(
          "agent.plan.created",
          {
            runId,
            plan: {
              id: plan.id,
              goal: plan.goal,
              summary: plan.summary,
              steps: plan.steps.length,
            },
          },
          { runId, conversationId },
        );
      }

      // ── Step 4: Tool Decision ─────────────────────────────────────
      await this.deps.runStateManager.markStatus(runId, "tool_deciding");
      const decision = await this.deps.toolDecisionEngine.decide(
        { context, intent, plan },
        signal,
      );

      // ── Branch A: Use Tool ────────────────────────────────────────
      if (decision.type === "use_tool") {
        // Emit tool selected events
        for (const tc of decision.toolCalls) {
          this.deps.eventBus.emit(
            "agent.tool.selected",
            {
              runId,
              toolCallId: tc.id,
              skillId: tc.skillId,
              name: tc.name,
              riskLevel: tc.riskLevel,
            },
            { runId, conversationId },
          );
        }

        // Check permissions
        for (const tc of decision.toolCalls) {
          const permDecision = await this.deps.permissionPolicy.evaluate({
            userId: input.userId,
            runId,
            skillId: tc.skillId,
            permissions: tc.permissions,
            arguments: tc.arguments,
            context,
          });

          if (!permDecision.allowed) {
            throw Object.assign(
              new Error(
                `Permission denied for ${tc.name}: ${permDecision.reasons.join(", ")}`,
              ),
              { code: "AGENT_PERMISSION_DENIED", category: "permission" },
            );
          }

          if (permDecision.requiresApproval) {
            const approvalRiskLevel = maxRiskLevel(
              tc.riskLevel,
              permDecision.riskLevel,
            );
            await this.requestApproval({
              runId,
              conversationId,
              toolCallId: tc.id,
              title: `Approve ${tc.name}`,
              description: `Run tool ${tc.name} with risk level ${approvalRiskLevel}`,
              riskLevel: approvalRiskLevel,
              requestedAction: {
                skillId: tc.skillId,
                arguments: tc.arguments,
                permissions: tc.permissions,
              },
            });

            return {
              runId,
              conversationId,
              status: "waiting_approval",
              artifacts: [],
              toolCalls: [],
            };
          }
        }

        return this.executeToolDecision(
          input,
          context,
          intent,
          plan,
          decision,
          signal,
        );
      }

      // ── Branch B: No Tool ─────────────────────────────────────────
      if (decision.type === "no_tool") {
        await this.deps.runStateManager.markStatus(runId, "responding");

        const response = await this.deps.responseComposer.composeDirect(
          { input, context, intent, plan },
          signal,
        );

        this.deps.eventBus.emit(
          "agent.response.completed",
          {
            runId,
            conversationId,
            messageId: response.messageId,
          },
          { runId, conversationId },
        );

        await this.writeMemories({
          input,
          context,
          intent,
          plan,
          responseMessageId: response.messageId,
        });

        await this.deps.runStateManager.markStatus(runId, "completed");
        this.deps.eventBus.emit(
          "agent.run.completed",
          {
            runId,
            assistantMessageId: response.messageId,
            artifacts: [],
            toolCalls: 0,
          },
          { runId, conversationId },
        );

        return {
          runId,
          conversationId,
          assistantMessageId: response.messageId,
          status: "completed",
          artifacts: [],
          toolCalls: [],
        };
      }

      // ── Branch C: Ask Clarification ───────────────────────────────
      if (decision.type === "ask_clarification") {
        await this.deps.runStateManager.markStatus(runId, "responding");
        const response = await this.deps.responseComposer.composeClarification({
          input,
          question: decision.question,
          reason: decision.reason,
        });

        this.deps.eventBus.emit(
          "agent.response.completed",
          {
            runId,
            conversationId,
            messageId: response.messageId,
          },
          { runId, conversationId },
        );

        await this.deps.runStateManager.markStatus(runId, "completed");
        this.deps.eventBus.emit(
          "agent.run.completed",
          {
            runId,
            assistantMessageId: response.messageId,
            artifacts: [],
            toolCalls: 0,
          },
          { runId, conversationId },
        );

        return {
          runId,
          conversationId,
          assistantMessageId: response.messageId,
          status: "completed",
          artifacts: [],
          toolCalls: [],
        };
      }

      // ── Branch D: Require Approval (blocked at decision stage) ────
      if (decision.type === "require_approval") {
        const approval = await this.requestApproval({
          runId,
          conversationId,
          title: decision.approval.title,
          description: decision.approval.description,
          riskLevel: decision.approval.riskLevel as
            | "low"
            | "medium"
            | "high"
            | "critical",
          requestedAction: {
            skillId: "",
            arguments: {},
            permissions: [],
          },
        });

        return {
          runId,
          conversationId,
          status: "waiting_approval",
          artifacts: [],
          toolCalls: [],
        };
      }

      // Fallback: treat as no_tool
      await this.deps.runStateManager.markStatus(runId, "completed");
      return {
        runId,
        conversationId,
        status: "completed",
        artifacts: [],
        toolCalls: [],
      };
    } catch (error) {
      // Handle explicit abort
      if (signal.aborted) {
        await this.deps.runStateManager.markCancelled(runId, "aborted by user");
        this.deps.eventBus.emit(
          "agent.run.cancelled",
          { runId, reason: "aborted by user" },
          { runId, conversationId },
        );
        return {
          runId,
          conversationId,
          status: "cancelled",
          artifacts: [],
          toolCalls: [],
        };
      }

      // Normalize and record error
      const err = error instanceof Error ? error : new Error(String(error));
      const agentError = {
        code: (error as { code?: string }).code ?? "AGENT_INTERNAL_ERROR",
        message: err.message,
        category: (error as { category?: string }).category ?? "internal",
        retryable: (error as { retryable?: boolean }).retryable ?? false,
      };

      await this.deps.runStateManager.markFailed(runId, error);
      this.deps.eventBus.emit(
        "agent.run.failed",
        { runId, error: agentError },
        { runId, conversationId },
      );
      this.deps.eventBus.emit(
        "agent.error",
        {
          runId,
          conversationId,
          code: agentError.code,
          message: agentError.message,
          category: agentError.category,
          retryable: agentError.retryable,
        },
        { runId, conversationId },
      );

      return {
        runId,
        conversationId,
        status: "failed",
        artifacts: [],
        toolCalls: [],
        error: agentError,
      };
    }
  }

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
      mode:
        run.mode === "chat" || run.mode === "agent" || run.mode === "workflow"
          ? run.mode
          : "agent",
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

      return await this.executeToolDecision(
        input,
        context,
        intent,
        undefined,
        decision,
        signal,
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

  private async requestApproval(input: {
    runId: string;
    conversationId: string;
    stepId?: string;
    toolCallId?: string;
    title: string;
    description: string;
    riskLevel: RiskLevel;
    requestedAction: {
      skillId: string;
      arguments: Record<string, unknown>;
      permissions: Permission[];
    };
  }): Promise<{ id: string; status: string }> {
    if (this.deps.approvalRequestService) {
      const result =
        await this.deps.approvalRequestService.requestApproval(input);
      this.deps.eventBus.publish(result.event);
      return result.approval;
    }

    await this.deps.runStateManager.markStatus(
      input.runId,
      "waiting_approval",
      `awaiting approval for ${input.title}`,
    );
    const approval = await this.deps.approvalGate.createApproval(input);
    this.deps.eventBus.emit(
      "agent.approval.required",
      {
        runId: input.runId,
        approvalId: approval.id,
        title: input.title,
        riskLevel: input.riskLevel,
      },
      { runId: input.runId, conversationId: input.conversationId },
    );
    return approval;
  }

  private async executeToolDecision(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    plan: AgentPlan | undefined,
    decision: ToolDecision & { type: "use_tool" },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    await this.deps.runStateManager.markStatus(runId, "executing");
    const observation = await this.deps.executionOrchestrator.execute(
      {
        runId,
        context,
        intent,
        plan,
        decision,
      },
      signal,
    );

    await this.deps.runStateManager.markStatus(runId, "reflecting");
    const reflection = await this.deps.reflectionEngine.reflect(
      {
        context,
        intent,
        plan,
        observation,
      },
      signal,
    );

    await this.deps.runStateManager.markStatus(runId, "responding");

    const response = await this.deps.responseComposer.composeFromObservation(
      { input, context, observation, reflection },
      signal,
    );

    this.deps.eventBus.emit(
      "agent.response.completed",
      {
        runId,
        conversationId,
        messageId: response.messageId,
      },
      { runId, conversationId },
    );

    await this.writeMemories({
      input,
      context,
      intent,
      plan,
      responseMessageId: response.messageId,
      observation,
      reflection,
    });

    await this.deps.runStateManager.markStatus(runId, "completed");
    this.deps.eventBus.emit(
      "agent.run.completed",
      {
        runId,
        assistantMessageId: response.messageId,
        artifacts: observation.artifacts.map((a) => a.id),
        toolCalls: observation.toolCalls.length,
      },
      { runId, conversationId },
    );

    return {
      runId,
      conversationId,
      assistantMessageId: response.messageId,
      status: "completed",
      artifacts: observation.artifacts,
      toolCalls: observation.toolCalls,
    };
  }

  private async writeMemories(
    input: Parameters<
      NonNullable<AgentLoopEngineDeps["memoryWriter"]>["writeFromTurn"]
    >[0],
  ): Promise<void> {
    if (!this.deps.memoryWriter) return;

    try {
      const result = await this.deps.memoryWriter.writeFromTurn(input);
      for (const memory of result.written) {
        this.deps.eventBus.emit(
          "agent.memory.written",
          {
            runId: input.input.runId,
            memoryId: memory.id,
            type: memory.type ?? "manual_note",
            scope: memory.scope ?? "run",
          },
          {
            runId: input.input.runId,
            conversationId: input.input.conversationId,
          },
        );
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.deps.eventBus.emit(
        "agent.error",
        {
          runId: input.input.runId,
          conversationId: input.input.conversationId,
          code: "AGENT_MEMORY_WRITE_FAILED",
          message: err.message,
          category: "memory",
          retryable: true,
        },
        {
          runId: input.input.runId,
          conversationId: input.input.conversationId,
        },
      );
    }
  }
}

function intentFromSkillId(skillId: string): RoutedIntent["type"] {
  if (skillId.startsWith("filesystem.")) return "file_operation";
  if (skillId.startsWith("shell.")) return "shell_operation";
  if (skillId.startsWith("workflow.")) return "workflow_execution";
  if (skillId.startsWith("memory.")) return "memory_update";
  if (skillId.startsWith("artifact.")) return "artifact_generation";
  return "unknown";
}

function maxRiskLevel(left: RiskLevel, right: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return order[left] >= order[right] ? left : right;
}
