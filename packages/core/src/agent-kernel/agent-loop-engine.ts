import type { AgentEventBus } from "./agent-event-bus.js";
import type { RepositoryApprovalRequestService } from "./persistence/repository-approval-request-service.js";
import type {
  AgentLoopInput,
  AgentLoopResult,
  AgentContext,
  AgentObservation,
  AgentPlan,
  AgentPlanStepStatus,
  AgentReflection,
  AgentTaskState,
  RoutedIntent,
  Permission,
  RiskLevel,
  ToolDecision,
  PlannedToolCall,
  ToolCallSummary,
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
import type { PlanValidator } from "./planning/plan-validator.js";
import type { Replanner, ReplanTrigger } from "./planning/replanner.js";
import type { ModelRouter, ModelPurpose } from "./model-router.js";
import type { TraceManager } from "./trace-manager.js";
import type { RepositoryTraceManager } from "./trace-persistence.js";
import type { PromptInjectionDetector } from "./safety/prompt-injection-detector.js";
import type { ToolSandbox } from "./safety/tool-sandbox.js";
import type { TaskScopedPermissionManager, TaskScopedPermission } from "./safety/task-scoped-permission-manager.js";
import type { PlanSnapshotRepository } from "@sunpilot/storage";

const MAX_TOOL_ITERATIONS = 5;

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
  /** Optional — validates plans before execution for structural issues. */
  planValidator?: PlanValidator;
  /** Optional — revises plans when tool execution doesn't go as expected. */
  replanner?: Replanner;
  /** Optional — routes LLM calls to different models by purpose (§3). */
  modelRouter?: ModelRouter;
  /** Optional — creates trace/spans for observability (§7, §P0-2). */
  traceManager?: TraceManager | RepositoryTraceManager;
  /** Optional — detects prompt injection in untrusted content (§5). */
  injectionDetector?: PromptInjectionDetector;
  /** Optional — sandboxes tool execution for security (§5). */
  toolSandbox?: ToolSandbox;
  /** Optional — enforces task-scoped permission boundaries (§5). */
  scopedPermissionManager?: TaskScopedPermissionManager;
  /** Optional — persists plan snapshots (§P0-2). */
  planSnapshotRepo?: PlanSnapshotRepository;
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
 * AgentLoopEngine — 中央状态机，负责将每次用户交互走完完整 Agent Loop，
 * 而非一次性 LLM 调用。
 *
 * 完整流程（架构文档 §9）：
 *   created → context_building → intent_routing → (planning?) →
 *   tool_deciding → (executing → observing → reflecting)? → responding → completed
 *
 * 分支说明：
 * - no_tool：跳过 execute/observe/reflect，直接进入 responding
 * - use_tool：走完整的 execute→observe→reflect→responding 子流程
 * - ask_clarification：直接返回澄清问题，不调用 LLM 生成回答
 * - require_approval/waiting_approval：暂停状态机，等待用户审批后通过
 *   resumeApprovedTool 继续执行
 *
 * 引擎与传输层解耦：接收 AgentLoopInput，返回 AgentLoopResult。
 * WebSocket/REST 的接线由 daemon 层处理。
 */
export class AgentLoopEngine {
  /** Accumulated task-scoped permission grants keyed by runId. */
  private readonly grantsByRun = new Map<string, TaskScopedPermission[]>();
  /** Tracks plan revision counts per run for snapshot versioning (§P0-2). */
  private _planRevisionCounts?: Map<string, number>;

  constructor(private readonly deps: AgentLoopEngineDeps) {}

  /** Release permission grants for a run to prevent unbounded memory growth. */
  private cleanupGrants(runId: string): void {
    this.grantsByRun.delete(runId);
  }

  /**
   * 主流程编排器 — 将 Agent Loop 各阶段委托给专用 private 方法。
   *
   * 流程：buildContextAndIntent → maybeCreatePlan → decideTools →
   *       handleUseTool | handleNoTool | handleClarification | handleApprovalRequired
   */
  async run(
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    try {
      const { context, intent } = await this.buildContextAndIntent(
        input,
        signal,
      );
      const plan = await this.maybeCreatePlan(input, context, intent, signal);
      const decision = await this.decideTools(
        input,
        context,
        intent,
        plan,
        signal,
      );

      switch (decision.type) {
        case "use_tool":
          return this.handleUseTool(
            input,
            context,
            intent,
            plan,
            decision,
            signal,
          );
        case "no_tool":
          return this.handleNoTool(input, context, intent, plan, signal);
        case "ask_clarification":
          return this.handleClarification(input, decision, signal);
        case "require_approval":
          return this.handleApprovalRequired(input, decision, signal);
        default:
          // Fallback: treat as no_tool
          await this.deps.runStateManager.markStatus(input.runId, "completed");
          return {
            runId: input.runId,
            conversationId: input.conversationId,
            status: "completed",
            artifacts: [],
            toolCalls: [],
          };
      }
    } catch (error) {
      return this.handleLoopError(input, error, signal);
    }
  }

  // ── Phase methods ──────────────────────────────────────────────────

  /** 阶段 1+2：上下文构建 + 意图路由。 */
  private async buildContextAndIntent(
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<{ context: AgentContext; intent: RoutedIntent }> {
    const { runId, conversationId } = input;

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

    return { context, intent };
  }

  /** 阶段 3：规划（仅在意图需要时）。 */
  private async maybeCreatePlan(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    signal: AbortSignal,
  ): Promise<AgentPlan | undefined> {
    if (!intent.requiresPlanning) return undefined;

    const { runId, conversationId } = input;
    await this.deps.runStateManager.markStatus(runId, "planning");
    const plan = await this.deps.planner.createPlan(context, intent, signal);

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

    return plan;
  }

  /** 阶段 4：工具决策。 */
  private async decideTools(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    plan: AgentPlan | undefined,
    signal: AbortSignal,
    previousObservation?: AgentObservation,
    prioritySkills?: Array<{
      skillId: string;
      reason: string;
      argumentsHint?: Record<string, unknown>;
    }>,
  ): Promise<ToolDecision> {
    await this.deps.runStateManager.markStatus(input.runId, "tool_deciding");
    return this.deps.toolDecisionEngine.decide(
      { context, intent, plan, previousObservation, prioritySkills },
      signal,
    );
  }

  // ── Branch handlers ────────────────────────────────────────────────

  /** 分支 A：使用工具 — 权限检查 → 审批或执行。 */
  private async handleUseTool(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    plan: AgentPlan | undefined,
    decision: ToolDecision & { type: "use_tool" },
    signal: AbortSignal,
    iteration = 1,
    accumulatedObservation?: AgentObservation,
    taskState?: AgentTaskState,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;
    const deniedToolCalls = new Set<string>();

    for (const tc of decision.toolCalls) {
      this.deps.eventBus.emit(
        "agent.tool.selected",
        { runId, toolCallId: tc.id, skillId: tc.skillId, name: tc.name, riskLevel: tc.riskLevel },
        { runId, conversationId },
      );
    }

    // ── Safety pre-validation (§P0-3): sandbox + permission + scope ──
    for (const tc of decision.toolCalls) {
      // Layer 1: Sandbox validation — deny dangerous operations without throwing
      let sandboxDenied = false;
      if (this.deps.toolSandbox) {
        sandboxDenied = validateSandbox(this.deps.toolSandbox, tc, (op, reason) => {
          this.deps.eventBus!.emit(
            "agent.safety.sandbox_denied",
            { runId, conversationId, toolCallId: tc.id, skillId: tc.skillId, operation: op, reason, mode: this.deps.toolSandbox!.config.mode, recoverable: true },
            { runId, conversationId },
          );
        });
        if (sandboxDenied) {
          deniedToolCalls.add(tc.id);
          tc.metadata = { ...(tc.metadata ?? {}), safety: { deniedBy: "sandbox", blocked: true } };
          continue;
        }
      }

      // Layer 2: Scoped permission check — detect reauth needs
      if (this.deps.scopedPermissionManager) {
        const existingGrants = this.grantsByRun.get(runId) ?? [];
        const planStepId = plan?.steps.find(
          (s) => s.skillId === tc.skillId && (s.status === "pending" || s.status === "in_progress"),
        )?.id;
        const scopedCheck = this.deps.scopedPermissionManager.check({
          requestedPermission: tc.permissions[0] ?? "shell.execute",
          runId, planStepId, toolCallId: tc.id, skillId: tc.skillId,
          arguments: tc.arguments, existingGrants,
          permissionMode: input.permissionMode ?? "ask",
        });
        if (scopedCheck.needsReapproval) {
          this.deps.eventBus.emit(
            "agent.safety.scope_reauth_required",
            { runId, conversationId, toolCallId: tc.id, skillId: tc.skillId, reason: scopedCheck.reason },
            { runId, conversationId },
          );
          tc.requiresApproval = true;
        }
      }

      // Layer 3: Permission policy evaluation
      const permDecision = await this.deps.permissionPolicy.evaluate({
        userId: input.userId, runId, skillId: tc.skillId, permissions: tc.permissions,
        arguments: tc.arguments, context, permissionMode: input.permissionMode, riskHints: tc.riskHints,
      });

      if (!permDecision.allowed) {
        this.deps.eventBus.emit(
          "agent.safety.scope_reauth_required",
          { runId, conversationId, toolCallId: tc.id, skillId: tc.skillId,
            reason: `Permission denied: ${permDecision.reasons.join(", ")}` },
          { runId, conversationId },
        );
        deniedToolCalls.add(tc.id);
        tc.metadata = { ...(tc.metadata ?? {}), safety: { deniedBy: "permission", reasons: permDecision.reasons, blocked: true } };
        continue;
      }

      if (permDecision.requiresApproval) {
        await this.requestApproval({
          runId, conversationId, toolCallId: tc.id,
          title: `Approve ${tc.name}`,
          description: `Run tool ${tc.name} with arguments: ${JSON.stringify(summarizeArguments(tc.arguments))}`,
          riskLevel: maxRiskLevel(tc.riskLevel, permDecision.riskLevel),
          requestedAction: { skillId: tc.skillId, arguments: tc.arguments, permissions: tc.permissions, toolCallId: tc.id },
        });
        return { runId, conversationId, status: "waiting_approval", artifacts: [], toolCalls: [] };
      }

      // Record grant for completed permission checks
      if (this.deps.scopedPermissionManager) {
        const grants = this.grantsByRun.get(runId) ?? [];
        grants.push({
          permission: tc.permissions[0] ?? "shell.execute", runId, toolCallId: tc.id,
          skillId: tc.skillId, approvedArgs: { ...tc.arguments },
          grantedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
          grantedBy: "agent", riskLevel: tc.riskLevel as RiskLevel, scope: "this_run" as const,
        });
        this.grantsByRun.set(runId, grants);
      }
    }

    // If all tool calls were denied by sandbox/permission, create synthetic observation
    // and enter reflection directly — the agent can explain the denial (§P0-3).
    if (deniedToolCalls.size > 0 && deniedToolCalls.size === decision.toolCalls.length) {
      const deniedSummaries = decision.toolCalls.map((tc) => ({
        id: tc.id, skillId: tc.skillId, name: tc.name,
        status: "failed" as const,
        summary: `[SAFETY_DENIED] ${tc.name} was blocked`,
        metadata: { safety: (tc.metadata as Record<string, unknown>)?.["safety"], trust: "untrusted" as const, blocked: true },
      }));
      const safetyObservation: AgentObservation = {
        runId, toolCalls: deniedSummaries, artifacts: [],
        summary: `Safety denied ${deniedToolCalls.size} tool(s): ${deniedSummaries.map((d) => d.skillId).join(", ")}`,
      };
      // Skip execution, go directly to reflection/response
      await this.deps.runStateManager.markStatus(runId, "reflecting");
      const reflectResult = await this.deps.reflectionEngine.reflect(
        { context, intent, plan, observation: safetyObservation, taskState: taskState ?? emptyTaskState() },
        signal,
      );
      return this.respondAfterReflection(input, context, intent, plan, safetyObservation, reflectResult, signal);
    }

    // Build safe decision without denied calls
    const safeCalls = decision.toolCalls.filter((tc) => !deniedToolCalls.has(tc.id));
    const safeDecision: ToolDecision & { type: "use_tool" } = { ...decision, toolCalls: safeCalls };

    // Mark plan steps in_progress and bind planStepId
    if (plan) {
      for (const tc of safeCalls) {
        const matchingStep = plan.steps.find((s) => s.skillId === tc.skillId && s.status === "pending");
        if (matchingStep) {
          matchingStep.status = "in_progress";
          matchingStep.updatedAt = new Date().toISOString();
          tc.metadata = { ...(tc.metadata ?? {}), planStepId: matchingStep.id };
        }
      }
    }

    return this.executeToolDecision(
      input, context, intent, plan, safeDecision, signal, iteration, accumulatedObservation, taskState,
    );
  }

  /** 分支 B：无需工具 — 直接 LLM 生成回复。 */
  private async handleNoTool(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    plan: AgentPlan | undefined,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    await this.deps.runStateManager.markStatus(runId, "responding");
    const response = await this.deps.responseComposer.composeDirect(
      { input, context, intent, plan },
      signal,
    );

    this.deps.eventBus.emit(
      "agent.response.completed",
      { runId, conversationId, messageId: response.messageId },
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

  /** 分支 C：请求澄清 — 向用户发问。 */
  private async handleClarification(
    input: AgentLoopInput,
    decision: ToolDecision & { type: "ask_clarification" },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    await this.deps.runStateManager.markStatus(runId, "responding");
    const response = await this.deps.responseComposer.composeClarification({
      input,
      question: decision.question,
      reason: decision.reason,
    });

    this.deps.eventBus.emit(
      "agent.response.completed",
      { runId, conversationId, messageId: response.messageId },
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

  /** 分支 D：决策阶段即需审批。 */
  private async handleApprovalRequired(
    input: AgentLoopInput,
    decision: ToolDecision & { type: "require_approval" },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    await this.requestApproval({
      runId: input.runId,
      conversationId: input.conversationId,
      title: decision.approval.title,
      description: decision.approval.description,
      riskLevel: decision.approval.riskLevel as RiskLevel,
      requestedAction: { skillId: "", arguments: {}, permissions: [] },
    });

    return {
      runId: input.runId,
      conversationId: input.conversationId,
      status: "waiting_approval",
      artifacts: [],
      toolCalls: [],
    };
  }

  /** 异常处理：区分用户取消 vs 系统错误。 */
  private async handleLoopError(
    input: AgentLoopInput,
    error: unknown,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

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

      // Build an empty observation for the skipped tool
      const skippedObservation: AgentObservation = {
        runId: input.runId,
        toolCalls: input.rejectedToolCallId
          ? [
              {
                id: input.rejectedToolCallId,
                skillId: "rejected",
                name: "Rejected tool",
                status: "failed",
                summary:
                  "Tool execution was rejected by user. Continue without this tool.",
              },
            ]
          : [],
        artifacts: [],
        summary: "Tool rejected — continuing without tool execution.",
      };

      const intent: RoutedIntent = {
        type: "use_skill",
        confidence: 0.5,
        requiresPlanning: false,
        requiresTool: false,
        requiresApproval: false,
        riskLevel: "low",
        candidateSkills: [],
        reason: "continue_without_tool after rejection",
      };

      const reflection = await this.deps.reflectionEngine.reflect(
        { context, intent, observation: skippedObservation },
        signal,
      );

      await this.deps.runStateManager.markStatus(input.runId, "responding");
      const response = await this.deps.responseComposer.composeFromObservation(
        {
          input: agentInput,
          context,
          observation: skippedObservation,
          reflection,
        },
        signal,
      );

      this.deps.eventBus.emit(
        "agent.response.completed",
        {
          runId: input.runId,
          conversationId: input.conversationId,
          messageId: response.messageId,
        },
        { runId: input.runId, conversationId: input.conversationId },
      );

      await this.deps.runStateManager.markStatus(input.runId, "completed");
      this.deps.eventBus.emit(
        "agent.run.completed",
        {
          runId: input.runId,
          assistantMessageId: response.messageId,
          artifacts: [],
          toolCalls: 0,
        },
        { runId: input.runId, conversationId: input.conversationId },
      );

      return {
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId: response.messageId,
        status: "completed",
        artifacts: [],
        toolCalls: [],
      };
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

  /**
   * 发起审批请求。
   *
   * 两条路径：
   * 1. DB 持久化审批（approvalRequestService 存在）：写入 DB 并发布预构建事件
   * 2. 内存审批（仅 approvalGate）：写入内存并 emit 事件
   *
   * 审批请求创建后，状态机暂停在 waiting_approval，等待 approve() 或 reject()。
   */
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
      toolCallId?: string;
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
        description: input.description,
        riskLevel: input.riskLevel,
        skillId: input.requestedAction.skillId,
        argumentsPreview: summarizeArguments(input.requestedAction.arguments),
        reasons: buildRiskReasons(input.riskLevel, input.requestedAction),
      },
      { runId: input.runId, conversationId: input.conversationId },
    );
    return approval;
  }

  /**
   * 工具执行的子状态机：executing → reflecting → responding → writeMemories。
   *
   * 这是 use_tool 分支的核心执行路径：
   * 1. executionOrchestrator.execute：并发执行工具调用（含重试）
   * 2. reflectionEngine.reflect：评估工具执行结果是否达成目标
   * 3. responseComposer.composeFromObservation：LLM 将工具结果总结为用户可读的回复
   * 4. writeMemories：根据 turn 中的显式记忆请求或隐式规则写入记忆
   */
  private async executeToolDecision(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    plan: AgentPlan | undefined,
    decision: ToolDecision & { type: "use_tool" },
    signal: AbortSignal,
    iteration = 1,
    accumulatedObservation?: AgentObservation,
    taskState?: AgentTaskState,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    await this.deps.runStateManager.markStatus(runId, "executing");
    const latestObservation = await this.deps.executionOrchestrator.execute(
      {
        runId,
        context,
        intent,
        plan,
        decision,
      },
      signal,
    );
    const observation = mergeObservations(
      runId,
      accumulatedObservation,
      latestObservation,
    );

    // Maintain task state across iterations
    const updatedTaskState = updateTaskState(
      taskState,
      observation,
      plan,
      intent,
      iteration,
    );

    // Persist task state so resume/retry retains multi-turn progress
    await this.deps.runStateManager
      .saveTaskState(runId, updatedTaskState)
      .catch(() => {
        // Best effort — non-blocking
      });

    // ── Injection scan on latest execution results (§P0-3) ───────────
    if (this.deps.injectionDetector) {
      for (const tc of latestObservation.toolCalls) {
        if (tc.summary) {
          const detection = this.deps.injectionDetector.detect(tc.summary);
          if (detection.shouldBlock) {
            tc.summary = `[BLOCKED] Content blocked due to potential prompt injection (${detection.matches.length} matches).`;
            (tc as unknown as Record<string, unknown>).trust = "untrusted";
            (tc as unknown as Record<string, unknown>).blocked = true;
            this.deps.eventBus.emit(
              "agent.safety.injection_detected",
              { runId, conversationId, toolCallId: tc.id, source: "tool_result",
                matches: detection.matches.map((m) => ({ category: m.category, severity: m.severity, explanation: m.explanation })),
                blocked: true, contentSnippet: tc.summary.slice(0, 200) },
              { runId, conversationId },
            );
          } else if (detection.shouldWarn && detection.warningMessage) {
            tc.summary = `${detection.warningMessage}\n\n${tc.summary}`;
          }
        }
      }
    }

    await this.deps.runStateManager.markStatus(runId, "reflecting");
    const reflection = await this.deps.reflectionEngine.reflect(
      {
        context,
        intent,
        plan,
        observation,
        taskState: updatedTaskState,
      },
      signal,
    );

    // Apply max-iterations stop reason when the loop is forced to stop
    const stoppedByMaxIterations =
      reflection.nextAction === "continue" &&
      !reflection.goalAchieved &&
      iteration >= MAX_TOOL_ITERATIONS;
    const effectiveReflection = stoppedByMaxIterations
      ? {
          ...reflection,
          stopReason: "max_iterations" as const,
          summary: reflection.summary
            ? `${reflection.summary} (stopped after ${MAX_TOOL_ITERATIONS} tool iterations)`
            : `Task interrupted after ${MAX_TOOL_ITERATIONS} tool iterations.`,
        }
      : reflection;

    if (
      reflection.nextAction === "continue" &&
      !reflection.goalAchieved &&
      iteration < MAX_TOOL_ITERATIONS
    ) {
      // Pass reflection's next-tool suggestions as priority skills.
      // The ToolDecisionEngine tries these first before falling back
      // to normal candidate matching, giving reflection a stronger
      // influence on the next round of tool selection.
      const nextContext = appendObservationToContext(context, observation);
      const nextDecision = await this.decideTools(
        input,
        nextContext,
        intent,
        plan,
        signal,
        observation,
        reflection.nextToolCandidates,
      );

      switch (nextDecision.type) {
        case "use_tool":
          return this.handleUseTool(
            input,
            nextContext,
            intent,
            plan,
            nextDecision,
            signal,
            iteration + 1,
            observation,
            updatedTaskState,
          );
        case "ask_clarification":
          return this.handleClarification(input, nextDecision, signal);
        case "require_approval":
          return this.handleApprovalRequired(input, nextDecision, signal);
        case "no_tool":
          context = nextContext;
          break;
      }
    }

    await this.deps.runStateManager.markStatus(runId, "responding");

    const response = await this.deps.responseComposer.composeFromObservation(
      { input, context, observation, reflection: effectiveReflection },
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

    // Determine if a proactive conversation summary should be generated.
    // Trigger when token budget is strained (>40% used) or many iterations.
    const tokenRatio =
      context.limits.usedTokensEstimate /
      Math.max(1, context.limits.maxTokens);
    const shouldForceSummary =
      tokenRatio > 0.4 ||
      observation.toolCalls.length >= 15 ||
      iteration > 3;

    await this.writeMemories({
      input,
      context,
      intent,
      plan,
      responseMessageId: response.messageId,
      observation,
      reflection: effectiveReflection,
      forceSummary: shouldForceSummary,
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

  /**
   * 写入记忆（最佳努力，失败不阻塞主流程）。
   *
   * 写入策略由 MemoryWriter 内部决定：
   * - 用户显式"记住" → 高置信度写入
   * - 意图为 memory_update → 中置信度写入
   * - 工具任务完成 → 生成任务摘要记忆
   *
   * 每条写入的记忆都会 emit agent.memory.written 事件。
   */
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

  /**
   * Compose a response after safety-denial reflection (§P0-3).
   * Used when all tool calls were blocked by sandbox/permission.
   */
  private async respondAfterReflection(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    plan: AgentPlan | undefined,
    observation: AgentObservation,
    reflection: AgentReflection,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;
    await this.deps.runStateManager.markStatus(runId, "responding");
    const response = await this.deps.responseComposer.composeFromObservation(
      { input, context, observation, reflection },
      signal,
    );
    if (this.deps.traceManager) {
      this.deps.traceManager.endTrace(runId);
    }
    this.cleanupGrants(runId);
    return {
      runId, conversationId,
      assistantMessageId: response.messageId,
      status: "completed",
      artifacts: observation.artifacts,
      toolCalls: observation.toolCalls as ToolCallSummary[],
    };
  }
}

function intentFromSkillId(skillId: string): RoutedIntent["type"] {
  if (skillId.startsWith("filesystem.")) return "file_operation";
  if (skillId.startsWith("shell.")) return "shell_operation";
  if (skillId.startsWith("memory.")) return "memory_update";
  if (skillId.startsWith("artifact.")) return "artifact_generation";
  if (skillId.includes(":") || skillId.startsWith("automation"))
    return "automation_execution";
  return "unknown";
}

function appendObservationToContext(
  context: AgentContext,
  observation: AgentObservation,
): AgentContext {
  const toolResults = observation.toolCalls.map((call) => ({
    toolCallId: call.id,
    summary: call.summary,
    status: call.status,
  }));
  const toolMessages = observation.toolCalls.map((call) => ({
    role: "tool" as const,
    name: call.name,
    content: `${call.name} (${call.skillId}) ${call.status}: ${call.summary}`,
    metadata: {
      toolCallId: call.id,
      skillId: call.skillId,
      status: call.status,
    },
  }));

  return {
    ...context,
    messages: [...context.messages, ...toolMessages],
    toolResults: [...context.toolResults, ...toolResults],
    artifacts: [
      ...context.artifacts,
      ...observation.artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        type: artifact.type,
        summary: artifact.name,
      })),
    ],
  };
}

function mergeObservations(
  runId: string,
  previous: AgentObservation | undefined,
  latest: AgentObservation,
): AgentObservation {
  if (!previous) return latest;

  return {
    runId,
    toolCalls: [...previous.toolCalls, ...latest.toolCalls],
    artifacts: [...previous.artifacts, ...latest.artifacts],
    summary: [previous.summary, latest.summary].filter(Boolean).join("\n"),
  };
}

/**
 * Update AgentTaskState with the results of the latest tool execution.
 * Accumulates completed steps, gathered facts, and tracks open questions
 * across iterations to improve reflection accuracy.
 */
function updateTaskState(
  previous: AgentTaskState | undefined,
  observation: AgentObservation,
  plan: AgentPlan | undefined,
  intent: RoutedIntent,
  iteration: number,
): AgentTaskState {
  const goal = previous?.goal ?? plan?.goal ?? intent.reason ?? "Complete user request";

  // Track completed steps
  const completedSteps = [...(previous?.completedSteps ?? [])];
  const pendingSteps = [...(previous?.pendingSteps ?? [])];

  // On first iteration, initialize pending steps from plan
  if (!previous && plan) {
    for (const step of plan.steps) {
      if (!completedSteps.includes(step.id)) {
        pendingSteps.push(step.id);
      }
    }
  }

  // Mark tool steps as completed based on observation.
  // Prefer planStepId from metadata for stable binding when same skill
  // appears multiple times in the plan (§P0-2).
  for (const tc of observation.toolCalls) {
    const planStepId = (tc.metadata as Record<string, unknown> | undefined)?.["planStepId"] as string | undefined;
    const stepId = planStepId ?? `tool:${tc.skillId}`;
    if (tc.status === "completed") {
      if (!completedSteps.includes(stepId)) {
        completedSteps.push(stepId);
      }
      const pendingIdx = pendingSteps.indexOf(stepId);
      if (pendingIdx >= 0) pendingSteps.splice(pendingIdx, 1);
    }
  }

  // Accumulate gathered facts from tool results
  const gatheredFacts: Record<string, unknown> = {
    ...(previous?.gatheredFacts ?? {}),
  };
  for (const tc of observation.toolCalls) {
    if (tc.structured) {
      const totalResults =
        tc.structured.totalResults ??
        (Array.isArray(tc.structured.candidates)
          ? (tc.structured.candidates as unknown[]).length
          : Array.isArray(tc.structured.results)
            ? (tc.structured.results as unknown[]).length
            : undefined);
      if (totalResults !== undefined) {
        gatheredFacts[`${tc.skillId}.totalResults`] = totalResults;
      }
      if (tc.structured.summary) {
        gatheredFacts[`${tc.skillId}.summary`] = tc.structured.summary;
      }
    }
  }

  // Track open questions from reflection's missing info
  const openQuestions = [...(previous?.openQuestions ?? [])];

  return {
    goal,
    completedSteps,
    pendingSteps,
    gatheredFacts,
    openQuestions,
    iteration,
  };
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

/**
 * Summarize tool arguments for display in approval UI.
 * Truncates long values to keep the approval card readable.
 */
function summarizeArguments(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const summarized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 200) {
      summarized[key] = value.slice(0, 200) + "...";
    } else if (Array.isArray(value) && value.length > 5) {
      summarized[key] = `[${value.length} items]`;
    } else {
      summarized[key] = value;
    }
  }
  return summarized;
}

/**
 * Build human-readable risk reasons for approval events.
 */
function buildRiskReasons(
  riskLevel: RiskLevel,
  action: { skillId: string; permissions?: Permission[] },
): string[] {
  const reasons: string[] = [];
  if (riskLevel === "high" || riskLevel === "critical") {
    reasons.push(`Risk level: ${riskLevel}`);
  }
  const perms = action.permissions ?? [];
  if (perms.includes("filesystem.write") || perms.includes("filesystem.delete")) {
    reasons.push("Writes to filesystem");
  }
  if (perms.includes("shell.execute")) {
    reasons.push("Executes shell commands");
  }
  if (perms.includes("network.request")) {
    reasons.push("Makes network requests");
  }
  if (perms.includes("external.send")) {
    reasons.push("Sends data externally");
  }
  if (reasons.length === 0) {
    reasons.push("Low-risk operation");
  }
  return reasons;
}

// ── Safety helpers (§P0-3) ────────────────────────────────────────────────

/**
 * Validate a planned tool call against sandbox rules.
 * Returns true if the tool was denied, and calls onDenied with operation + reason.
 */
function validateSandbox(
  sandbox: NonNullable<AgentLoopEngineDeps["toolSandbox"]>,
  tc: PlannedToolCall,
  onDenied: (operation: string, reason: string) => void,
): boolean {
  // Filesystem validation
  if (tc.permissions.some((p) => p.startsWith("filesystem."))) {
    const path = (tc.arguments["path"] ?? tc.arguments["target"] ?? tc.arguments["file"]) as string | undefined;
    if (path) {
      const op = tc.permissions.includes("filesystem.delete") ? "delete"
        : tc.permissions.includes("filesystem.write") ? "write" : "read";
      const result = sandbox.validateFilesystem({ operation: op as "read" | "write" | "delete", path });
      if (!result.allowed) { onDenied(`filesystem.${op}`, result.reason!); return true; }
    }
  }
  // Shell validation
  if (tc.permissions.includes("shell.execute")) {
    const command = tc.arguments["command"] as string | undefined;
    if (command) {
      const result = sandbox.validateShell({ command, arguments: tc.arguments["args"] as string[] | undefined });
      if (!result.allowed) { onDenied("shell.execute", result.reason!); return true; }
    }
  }
  // Network validation
  if (tc.permissions.includes("network.request")) {
    const url = tc.arguments["url"] as string | undefined;
    if (url) {
      const result = sandbox.validateNetwork({ url });
      if (!result.allowed) { onDenied("network.request", result.reason!); return true; }
    }
  }
  return false;
}

/** Create an empty task state for initial safety-denial reflection. */
function emptyTaskState(): AgentTaskState {
  return { goal: "", completedSteps: [], pendingSteps: [], gatheredFacts: {}, openQuestions: [], iteration: 1 };
}
