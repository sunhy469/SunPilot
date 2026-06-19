import type { AgentEventBus } from "./agent-event-bus.js";
import type { RepositoryApprovalRequestService } from "./persistence/repository-approval-request-service.js";
import type {
  AgentLoopInput,
  AgentLoopResult,
  AgentContext,
  AgentObservation,
  AgentPlan,
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
  SaveMessageFn,
} from "./loop-types.js";
import type { RunStateManager } from "./run-state-manager.js";
import type { MemoryWriter } from "./memory/memory-types.js";
import type { PlanValidator } from "./planning/plan-validator.js";
import type { Replanner } from "./planning/replanner.js";
import type { ModelRouter } from "./model-router.js";
import type { TraceManager } from "./trace-manager.js";
import type { RepositoryTraceManager } from "./trace-persistence.js";
import type { PromptInjectionDetector } from "./safety/prompt-injection-detector.js";
import type { ToolSandbox } from "./safety/tool-sandbox.js";
import type {
  TaskScopedPermissionManager,
  TaskScopedPermission,
} from "./safety/task-scoped-permission-manager.js";
import type {
  PlanSnapshotRepository,
  ToolCallRepository,
} from "@sunpilot/storage";
import { AssistantMessageStream } from "./assistant-message-stream.js";

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
  /** Required — saves assistant messages (§Phase 3 of streaming refactoring). */
  saveMessage?: SaveMessageFn;
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
  /** Optional — persists tool calls for auditability (§P0-3). */
  toolCalls?: ToolCallRepository;
}

export interface ApprovalResumeInput {
  approvalId: string;
  runId: string;
  conversationId?: string;
  decidedBy?: string;
  title?: string;
  riskLevel?: RiskLevel;
  /** §P1-2: messageId for continuing the same assistant message after approval. */
  messageId?: string;
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

  /** Start a trace span if traceManager is available (§P1-5). Best-effort — never throws. */
  private _startSpan(
    runId: string,
    kind: import("./trace-manager.js").SpanKind,
    parentSpanId?: string,
  ): {
    spanId: string;
    endSpan: (
      summary: string,
      metrics?: import("./trace-manager.js").SpanMetrics,
      error?: string,
    ) => void;
  } | null {
    if (!this.deps.traceManager) return null;
    try {
      const { spanId, endSpan } = this.deps.traceManager.startSpan(
        runId,
        kind,
        parentSpanId,
      );
      return { spanId, endSpan };
    } catch {
      // No active trace yet (e.g. test harness without startTrace) — silently skip
      return null;
    }
  }

  /** Release permission grants for a run to prevent unbounded memory growth. */
  private cleanupGrants(runId: string): void {
    this.grantsByRun.delete(runId);
  }

  /** Increment and return the next plan version for a run (§P0-2). */
  private _nextPlanVersion(runId: string): number {
    if (!this._planRevisionCounts) {
      this._planRevisionCounts = new Map();
    }
    const next = (this._planRevisionCounts.get(runId) ?? 0) + 1;
    this._planRevisionCounts.set(runId, next);
    return next;
  }

  /** Clean up plan revision counter when a run completes. */
  private _cleanupPlanVersion(runId: string): void {
    this._planRevisionCounts?.delete(runId);
  }

  /**
   * 主流程编排器 — Codex-style content-block-first 架构。
   *
   * 流程：
   *   create stream FIRST (frontend sees message card immediately)
   *   → build context → maybe plan → decideTools (safety only)
   *   → content-block loop (model decides text/tool/text natively)
   *
   * Stream 在 context 构建之前创建，确保前端立刻显示 assistant
   * message card。模型通过 native function calling 自主决定是否
   * 调用工具 — decideTools() 仅作为安全门控和澄清检测。
   */
  async run(
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    if (this.deps.traceManager) {
      this.deps.traceManager.startTrace(input.runId, input.conversationId);
    }

    const messageId = `msg_${crypto.randomUUID()}`;

    // §Codex flow: Emit message.started early so the frontend creates
    // the assistant message card immediately, before context/plan/decision.
    // The model starts producing text once the content-block loop begins.
    // (stream.start() inside runContentBlockLoop will handle the rest.)
    if (this.deps.saveMessage) {
      this.deps.eventBus.emit("agent.message.started",
        { runId: input.runId, conversationId: input.conversationId, messageId },
        { runId: input.runId, conversationId: input.conversationId });
    }

    try {
      const { context, intent } = await this.buildContextAndIntent(
        input,
        signal,
      );
      const plan = await this.maybeCreatePlan(input, context, intent, signal);

      // Validate plan structure before tool decision (§P0-2)
      if (plan && this.deps.planValidator) {
        const validation = await this.deps.planValidator.validate(plan);
        this.deps.eventBus.emit(
          "agent.plan.validated",
          { runId: input.runId, planId: plan.id, valid: validation.valid, issues: validation.issues, executableSteps: validation.executableSteps, blockedSteps: validation.blockedSteps },
          { runId: input.runId, conversationId: input.conversationId },
        );
        if (this.deps.planSnapshotRepo) {
          try {
            await this.deps.planSnapshotRepo.create({
              id: crypto.randomUUID(), runId: input.runId, planId: plan.id,
              version: this._nextPlanVersion(input.runId),
              eventType: "agent.plan.validated",
              planJson: plan as unknown as Record<string, unknown>,
              diffSummary: validation.valid ? "Plan validated successfully" : `Validation found ${validation.issues.length} issue(s)`,
            });
          } catch { /* Best effort */ }
        }
      }

      // §Codex flow: decideTools() is now a SAFETY GATE only.
      // It detects ask_clarification and require_approval cases.
      // For use_tool and no_tool, the MODEL decides via native
      // function calling in the content-block loop.
      const decision = await this.decideTools(input, context, intent, plan, signal);

      switch (decision.type) {
        case "use_tool":
        case "no_tool":
          return this.runContentBlockLoop(input, context, intent, plan, decision, messageId, signal);
        case "ask_clarification":
          return this.handleClarification(input, decision, signal);
        case "require_approval":
          return this.runApprovalWithStream(input, decision, messageId, signal);
        default:
          await this.deps.runStateManager.markStatus(input.runId, "completed");
          return { runId: input.runId, conversationId: input.conversationId, status: "completed", artifacts: [], toolCalls: [] };
      }
    } catch (error) {
      return this.handleLoopError(input, error, signal);
    } finally {
      // Always end the trace and clean up plan version counter (§P0-2)
      if (this.deps.traceManager) {
        this.deps.traceManager.endTrace(input.runId);
      }
      this._cleanupPlanVersion(input.runId);
    }
  }

  // ── Phase methods ──────────────────────────────────────────────────

  /** 阶段 1+2：上下文构建 + 意图路由。 */
  private async buildContextAndIntent(
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<{ context: AgentContext; intent: RoutedIntent }> {
    const { runId, conversationId } = input;

    // ── Context building span (§P1-5) ──
    const ctxSpan = this._startSpan(runId, "context_building");
    const ctxStart = Date.now();

    await this.deps.runStateManager.markStatus(runId, "context_building");
    this.deps.eventBus.emit(
      "agent.context.started",
      { runId },
      { runId, conversationId },
    );

    let context: AgentContext;
    try {
      context = await this.deps.contextBuilder.build(input, signal);
    } catch (err) {
      ctxSpan?.endSpan(
        "Context building failed",
        { errorCode: "CONTEXT_BUILD_FAILED" },
        String(err),
      );
      throw err;
    }

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
    ctxSpan?.endSpan(
      `Context built: ${context.messages.length} msgs, ${context.memories.length} memories, ${context.tokenEstimate} tokens`,
      {
        tokenInput: context.tokenEstimate,
        toolCalls: context.toolResults.length,
      },
    );

    // ── Intent routing span (§P1-5) ──
    const intentSpan = this._startSpan(
      runId,
      "intent_routing",
      ctxSpan?.spanId,
    );

    await this.deps.runStateManager.markStatus(runId, "intent_routing");
    let intent: RoutedIntent;
    try {
      intent = await this.deps.intentRouter.route(context, signal);
    } catch (err) {
      intentSpan?.endSpan(
        "Intent routing failed",
        { errorCode: "INTENT_ROUTE_FAILED" },
        String(err),
      );
      throw err;
    }

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
    intentSpan?.endSpan(
      `Intent: ${intent.type} (confidence: ${intent.confidence})`,
      {
        toolCalls: intent.candidateSkills?.length,
        // Trace metadata for debugging tool selection (§P2):
        // embedding mode, top similarity score, form-match flag
        embeddingMode: intent.trace?.embeddingMode,
        embeddingTopScore: intent.trace?.embeddingTopScore,
        embeddingCandidateCount: intent.trace?.embeddingCandidateCount,
        formMatch: intent.trace?.formMatch,
      },
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
    const planSpan = this._startSpan(runId, "planning");

    await this.deps.runStateManager.markStatus(runId, "planning");
    let plan: AgentPlan;
    try {
      plan = await this.deps.planner.createPlan(context, intent, signal);
    } catch (err) {
      planSpan?.endSpan(
        "Planning failed",
        { errorCode: "PLAN_CREATE_FAILED" },
        String(err),
      );
      throw err;
    }

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
    planSpan?.endSpan(
      `Plan: ${plan.goal} (${plan.steps.length} steps, risk: ${plan.riskLevel})`,
    );

    // Persist plan snapshot (§P0-2)
    if (this.deps.planSnapshotRepo) {
      const version = this._nextPlanVersion(runId);
      try {
        await this.deps.planSnapshotRepo.create({
          id: crypto.randomUUID(),
          runId,
          planId: plan.id,
          version,
          eventType: "agent.plan.created",
          planJson: plan as unknown as Record<string, unknown>,
        });
        await this.deps.planSnapshotRepo.updateRunPlanState(
          runId,
          plan as unknown as Record<string, unknown>,
          version,
        );
      } catch (err) {
        // Snapshot persistence is best-effort — don't fail the run
        this.deps.eventBus.emit(
          "agent.error",
          {
            runId,
            error: {
              code: "PLAN_SNAPSHOT_WRITE_FAILED",
              message: `Failed to persist plan snapshot: ${String(err)}`,
            },
          },
          { runId, conversationId },
        );
      }
    }

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
    const toolSpan = this._startSpan(input.runId, "tool_deciding");
    await this.deps.runStateManager.markStatus(input.runId, "tool_deciding");
    const decision = await this.deps.toolDecisionEngine.decide(
      { context, intent, plan, previousObservation, prioritySkills },
      signal,
    );
    toolSpan?.endSpan(
      `Tool decision: ${decision.type}${decision.type === "use_tool" ? ` (${decision.toolCalls.length} tools)` : ""}`,
      {
        toolCalls: decision.type === "use_tool" ? decision.toolCalls.length : 0,
        // Decision path for debugging tool selection (§P2):
        // plan / intent_match / priority / deterministic_scorer /
        // llm_semantic / scorer_fallback / intent_skill_map / no_tool
        decisionPath: decision.decisionPath,
        // Retrieval metadata when available
        retrievalTopK: decision.retrievalTopK,
        retrievalCandidateCount: decision.retrievalCandidateCount,
        retrievalFallback: decision.retrievalFallback,
      },
    );
    return decision;
  }

  // ── Content-block stream methods (§Phase 3) ────────────────────────

  /**
   * Unified content-block loop — 主执行路径 (§P1-1).
   *
   * Handles both use_tool and no_tool decisions. The model always receives
   * a tool catalog and decides for itself whether to call tools.
   *
   * ToolDecisionEngine.executeStreaming() drives the LLM loop; the stream
   * manages content-block parts for text/status/tool interleaving.
   *
   * High-risk and approval-required tools still fall back to the old
   * safety-checked handleUseTool path.
   */
  private async runContentBlockLoop(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    plan: AgentPlan | undefined,
    decision: ToolDecision,
    messageId: string,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    // Approval-required tools go through the content-block stream with
    // saved partsSnapshot + pendingToolCall for resume.
    if (decision.type === "use_tool") {
      const hasApprovalRequired = decision.toolCalls.some(
        (tc) => tc.requiresApproval,
      );
      if (hasApprovalRequired) {
        return this.runApprovalForToolCalls(
          input, context, intent, plan, decision, messageId, signal,
        );
      }
    }

    // Create the stream for content-block parts
    const stream = new AssistantMessageStream({
      runId,
      conversationId,
      messageId,
      eventBus: this.deps.eventBus,
      saveMessage: this.deps.saveMessage!,
      skipStartedEvents: true,
    });
    stream.start();

    try {
      let assistantMessageId: string;
      let artifacts: import("./loop-types.js").ArtifactRef[] = [];
      let toolCalls: import("./loop-types.js").ToolCallSummary[] = [];

      if (decision.type === "use_tool") {
        // Tool path: LLM native function calling loop
        await this.deps.runStateManager.markStatus(runId, "executing");

        const result = await this.deps.toolDecisionEngine.executeStreaming(
          {
            runId,
            conversationId,
            context,
            intent,
            plan,
            messageId,
            modelId: input.modelId,
            permissionMode: input.permissionMode,
            stream,
          },
          signal,
        );
        assistantMessageId = result.messageId;
        artifacts = result.artifacts;
        toolCalls = result.toolCalls;
      } else if (decision.type === "no_tool") {
        // no_tool path: direct LLM response via ResponseComposer with stream
        await this.deps.runStateManager.markStatus(runId, "responding");

        const textPart = stream.startTextPart();
        await this.deps.responseComposer.composeDirect(
          {
            input,
            context,
            intent,
            plan,
            modelId: input.modelId,
            stream: { stream, textPartId: textPart.id },
          },
          signal,
        );
        stream.completeTextPart(textPart.id);
        assistantMessageId = messageId;
      }

      // Complete the stream (saves message, emits completion events)
      const completed = await stream.complete();

      // §Write memories — non-blocking, don't let it delay message completion
      const tokenRatio = context.limits.usedTokensEstimate / Math.max(1, context.limits.maxTokens);
      this.writeMemories({
        input,
        context,
        intent,
        plan,
        responseMessageId: messageId,
        observation: toolCalls.length > 0
          ? { runId, toolCalls, artifacts, summary: toolCalls.map((t) => t.summary).join("\n") }
          : undefined,
        forceSummary: tokenRatio > 0.4 || toolCalls.length >= 15,
      }).catch((err) => {
        this.deps.eventBus.emit(
          "agent.error",
          {
            runId,
            code: "AGENT_MEMORY_WRITE_FAILED",
            message: `Memory write failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
            category: "memory",
            retryable: true,
          },
          { runId, conversationId },
        );
      });

      // Mark run as completed
      await this.deps.runStateManager.markStatus(runId, "responding");
      await this.deps.runStateManager.markStatus(runId, "completed");

      this.deps.eventBus.emit(
        "agent.run.completed",
        {
          runId,
          assistantMessageId: completed.messageId,
          artifacts: artifacts.map((a) => a.id),
          toolCalls: toolCalls.length,
        },
        { runId, conversationId },
      );

      this.cleanupGrants(runId);
      this._cleanupPlanVersion(runId);

      return {
        runId,
        conversationId,
        assistantMessageId: completed.messageId,
        status: "completed",
        artifacts,
        toolCalls,
      };
    } catch (error) {
      if (signal.aborted) {
        // §P1-3: Emit cancellation as content-block parts before completing
        // the stream, so the history shows "已停止" instead of a blank card.
        try {
          stream.startStatus({
            label: "已停止",
            metadata: { phase: "completed" },
          });
          const stopText = stream.startTextPart();
          stream.appendText(stopText.id, "已停止。");
          stream.completeTextPart(stopText.id);
        } catch {
          // Best effort — stream may already be closed
        }
        await stream.complete().catch(() => { /* Best effort */ });

        await this.deps.runStateManager.markCancelled(runId, "aborted by user");
        this.deps.eventBus.emit(
          "agent.run.cancelled",
          { runId, reason: "aborted by user" },
          { runId, conversationId },
        );
        this.cleanupGrants(runId);
        this._cleanupPlanVersion(runId);
        return {
          runId,
          conversationId,
          status: "cancelled",
          artifacts: [],
          toolCalls: [],
        };
      }

      // §5.7: runNarrativeLoop fallback removed — streaming failures
      // are now handled by the stream's error mechanism directly.
      // No fallback to legacy narrative path.

      // Complete stream with error
      await stream.complete().catch(() => {
        // Best effort
      });

      throw error;
    }
  }

  /**
   * §P1-3: Content-block approval for specific tool calls.
   *
   * Creates a stream with status + text parts showing what needs approval,
   * saves partsSnapshot + pendingToolCall for resume, and returns
   * waiting_approval so the run pauses until the user decides.
   */
  private async runApprovalForToolCalls(
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
    const textPart = stream.startTextPart();
    stream.appendText(
      textPart.id,
      `这个操作需要你的确认：我将调用 ${toolNames}。`,
    );
    stream.completeTextPart(textPart.id);

    // Emit status parts for each tool needing approval
    for (const tc of decision.toolCalls) {
      stream.startStatus({
        label: `等待确认: ${tc.name}`,
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
  private async runApprovalWithStream(
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
        label: `等待确认: ${decision.approval.title}`,
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

  // ── Branch handlers ────────────────────────────────────────────────


  /** 分支 B：无需工具 — 直接 LLM 生成回复。 */
  /** 分支 C：请求澄清 — 向用户发问（§P1: content-block stream）。 */
  private async handleClarification(
    input: AgentLoopInput,
    decision: ToolDecision & { type: "ask_clarification" },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;
    const messageId = `msg_${crypto.randomUUID()}`;

    await this.deps.runStateManager.markStatus(runId, "responding");

    // §P1: Content-block stream path for clarification.
    // Emits text part + optional status, then completes the message.
    if (this.deps.saveMessage) {
      const stream = new AssistantMessageStream({
        runId,
        conversationId,
        messageId,
        eventBus: this.deps.eventBus,
        saveMessage: this.deps.saveMessage,
        skipStartedEvents: true,
      });
      stream.start();

      // Emit clarification as a text part
      const textPart = stream.startTextPart();
      stream.appendText(textPart.id, decision.question);
      stream.completeTextPart(textPart.id);

      // When the clarification was triggered by missing parameters,
      // add a recoverable error part so the UI can show context.
      if (decision.reason.includes("missing") || decision.reason.includes("缺少")) {
        stream.addError({
          message: decision.reason,
          code: "CLARIFICATION_NEEDED",
          recoverable: true,
        });
      }

      // Also emit legacy clarification event for backward compatibility
      this.deps.eventBus.emit(
        "agent.clarification.requested",
        {
          runId,
          conversationId,
          messageId,
          question: decision.question,
          reason: decision.reason,
        },
        { runId, conversationId },
      );

      await stream.complete();

      await this.deps.runStateManager.markStatus(runId, "completed");
      this.deps.eventBus.emit(
        "agent.run.completed",
        {
          runId,
          assistantMessageId: messageId,
          artifacts: [],
          toolCalls: 0,
        },
        { runId, conversationId },
      );

      this.cleanupGrants(runId);
      this._cleanupPlanVersion(runId);

      return {
        runId,
        conversationId,
        assistantMessageId: messageId,
        status: "completed",
        artifacts: [],
        toolCalls: [],
      };
    }

    // Fallback: old path (no saveMessage available)
    const response = await this.deps.responseComposer.composeClarification({
      input,
      question: decision.question,
      reason: decision.reason,
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

  /** 分支 D：决策阶段即需审批。 */
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
      this.cleanupGrants(runId);
      this._cleanupPlanVersion(runId);
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

    this.cleanupGrants(runId);
    this._cleanupPlanVersion(runId);
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

        // Emit rejection explanation as text
        const textPart = stream.startTextPart();
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
            if (!this._planRevisionCounts) {
              this._planRevisionCounts = new Map();
            }
            this._planRevisionCounts.set(run.runId, latest.version);
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
        let hydrateParts: import("./loop-types.js").AssistantMessagePart[] | undefined;
        let gatheredFacts: Record<string, unknown> | undefined;
        try {
          const runState = await this.deps.runStateManager.getRun(run.runId);
          gatheredFacts = runState?.taskState?.gatheredFacts as Record<string, unknown> | undefined;
          if (gatheredFacts?.partsSnapshot) {
            hydrateParts = gatheredFacts.partsSnapshot as import("./loop-types.js").AssistantMessagePart[];
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

        const allArtifacts: import("./loop-types.js").ArtifactRef[] = [];
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
          const followUpPart = stream.startTextPart();
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
  if (
    perms.includes("filesystem.write") ||
    perms.includes("filesystem.delete")
  ) {
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
