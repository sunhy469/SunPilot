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
  PreliminaryInferenceResult,
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
import { PreliminaryInferenceService } from "./agent-loop-engine/preliminary-inference.js";
import { ApprovalFlowCoordinator } from "./agent-loop-engine/approval-flow.js";
import { ApprovalContinuationCoordinator } from "./agent-loop-engine/approval-continuation.js";
import { RunPreparationCoordinator } from "./agent-loop-engine/run-preparation.js";
import { RunOutcomeCoordinator } from "./agent-loop-engine/run-outcomes.js";
import { RUN_PHASE_LABELS } from "./agent-loop-engine/constants.js";
import {
  buildRiskReasons,
  intentFromSkillId,
  intentLabelForStatus,
  maxRiskLevel,
  peekResolvedPromise,
  racePreliminaryWithTimeout,
  summarizeArguments,
} from "./agent-loop-engine/utils.js";

export { MAX_TOOL_ITERATIONS, RUN_PHASE_LABELS } from "./agent-loop-engine/constants.js";

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
  /** Optional — enables LLM pre-inference parallel with context building.
   *  Default: false. When true, a lightweight LLM call runs concurrently
   *  with context building to extract tool-matching hints. */
  enablePreliminaryInference?: boolean;
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

  private readonly preliminaryInference: PreliminaryInferenceService;
  private readonly approvalFlow: ApprovalFlowCoordinator;
  private readonly approvalContinuation: ApprovalContinuationCoordinator;
  private readonly runPreparation: RunPreparationCoordinator;
  private readonly runOutcomes: RunOutcomeCoordinator;

  constructor(private readonly deps: AgentLoopEngineDeps) {
    this.preliminaryInference = new PreliminaryInferenceService(deps);
    this.approvalFlow = new ApprovalFlowCoordinator(deps);
    this.runOutcomes = new RunOutcomeCoordinator(deps, (runId) => {
      this.cleanupGrants(runId);
      this._cleanupPlanVersion(runId);
    });
    this.runPreparation = new RunPreparationCoordinator(
      deps,
      (runId, kind, parentSpanId) => this._startSpan(runId, kind, parentSpanId),
      (runId) => this._nextPlanVersion(runId),
    );
    this.approvalContinuation = new ApprovalContinuationCoordinator(
      deps,
      (runId, version) => {
        if (!this._planRevisionCounts) this._planRevisionCounts = new Map();
        this._planRevisionCounts.set(runId, version);
      },
    );
  }

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

    // §P0-3: Track total turn latency for trace observability
    const turnStartTime = Date.now();

    const messageId = `msg_${crypto.randomUUID()}`;

    // §P1-1: Create the stream EARLY (before context building) and emit
    // a progress status so the user immediately sees activity instead of
    // a blank assistant card. The stream is passed through to
    // runContentBlockLoop() which adds actual content parts.
    // Pre-inference text never enters this stream — it's handled separately.
    const stream = this.deps.saveMessage
      ? new AssistantMessageStream({
          runId: input.runId,
          conversationId: input.conversationId,
          messageId,
          eventBus: this.deps.eventBus,
          saveMessage: this.deps.saveMessage,
          skipStartedEvents: true,
        })
      : undefined;

    // §Codex flow: Emit message.started early so the frontend creates
    // the assistant message card immediately, before context/plan/decision.
    // §P1-1: Track status part for granular progress updates through pipeline.
    let progressStatusId: string | undefined;
    if (stream) {
      this.deps.eventBus.emit("agent.message.started",
        { runId: input.runId, conversationId: input.conversationId, messageId },
        { runId: input.runId, conversationId: input.conversationId });
      stream.start();
      progressStatusId = stream.startStatus({
        label: RUN_PHASE_LABELS.intent_routing,
        metadata: { phase: "running" },
      }).id;
    }

    try {
      // §Parallel optimization: Optionally launch LLM pre-inference
      // concurrently with context building. Pre-inference uses only the
      // user message + system prompt (no context) and does NOT write to
      // the formal AssistantMessageStream — it only collects text and
      // tool hints.
      // §P3 opt: The pre-inference promise is passed into buildContextAndIntent
      // so it can be awaited AFTER context building but BEFORE intent routing.
      // This lets the pre-inference result skip the main IntentRouter Layer 2
      // LLM call when it completes quickly enough.
      const preliminaryPromise = this.deps.enablePreliminaryInference && this.deps.modelRouter
        ? this.preliminaryInference.run(input, signal)
        : undefined;

      // §P3 opt: buildContextAndIntent awaits the pre-inference internally
      // after context building and before intent routing.
      const { context, intent } = await this.runPreparation.buildContextAndIntent(
        input,
        signal,
        undefined, // pre-inference result not yet available — see below
        preliminaryPromise, // promise passed for internal await
      );

      // §P1-1: Update progress status — context is ready, now showing intent
      if (stream && progressStatusId) {
        const intentLabel = intentLabelForStatus(intent);
        stream.updateStatus(progressStatusId, {
          label: intentLabel,
          status: "completed",
        });
      }

      // §6.6: Get pre-inference result for tool hints. This is the SINGLE
      // place that may wait for pre-inference — and only with a short grace
      // period (200ms) so we don't block decideTools significantly. By this
      // point context building + intent routing have completed, so
      // pre-inference is very likely already resolved.
      // §3.2: If pre-inference still isn't ready, we proceed WITHOUT tool
      // hints rather than blocking the pipeline.
      const preliminary = preliminaryPromise
        ? await racePreliminaryWithTimeout(preliminaryPromise, 200)
        : undefined;

      // §P1-1: Update progress status when entering planning
      if (intent.requiresPlanning && stream) {
        progressStatusId = stream.startStatus({
          label: RUN_PHASE_LABELS.planning,
          metadata: { phase: "running" },
        }).id;
      }

      const plan = await this.runPreparation.maybeCreatePlan(input, context, intent, signal);

      // §P1-1: Update progress status — planning complete (or skipped)
      if (stream && progressStatusId && intent.requiresPlanning) {
        stream.updateStatus(progressStatusId, {
          label: plan ? "计划已制定，正在匹配工具..." : "正在匹配可用工具...",
          status: plan ? "completed" : "running",
        });
      }

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

      // §P1-1: Update progress status before tool decision
      if (stream && progressStatusId && !intent.requiresPlanning) {
        stream.updateStatus(progressStatusId, {
          label: "正在匹配可用工具...",
          status: "running",
        });
      }

      // §Codex flow: decideTools() is now a SAFETY GATE only.
      // It detects ask_clarification and require_approval cases.
      // For use_tool and no_tool, the MODEL decides via native
      // function calling in the content-block loop.
      // Pre-inference tool hints are injected as prioritySkills.
      const decision = await this.runPreparation.decideTools(
        input, context, intent, plan, signal,
        undefined,  // previousObservation
        preliminary?.toolHints,  // prioritySkills from pre-inference
      );

      // §P1-1: Update progress status after tool decision
      if (stream && progressStatusId) {
        const decisionLabel = decision.type === "use_tool"
          ? `匹配到 ${decision.toolCalls.length} 个工具，准备执行...`
          : decision.type === "no_tool"
            ? "正在生成回答..."
            : undefined;
        if (decisionLabel) {
          stream.updateStatus(progressStatusId, {
            label: decisionLabel,
            status: "completed",
          });
        }
      }

      switch (decision.type) {
        case "use_tool":
        case "no_tool":
          // §P1-1: Pass pre-created stream for early progress status
          return this.runContentBlockLoop(input, context, intent, plan, decision, messageId, signal, stream);
        case "ask_clarification":
          return this.runOutcomes.handleClarification(input, decision, signal);
        case "require_approval":
          return this.approvalFlow.runApprovalWithStream(input, decision, messageId, signal);
        default:
          await this.deps.runStateManager.markStatus(input.runId, "completed");
          return { runId: input.runId, conversationId: input.conversationId, status: "completed", artifacts: [], toolCalls: [] };
      }
    } catch (error) {
      return this.runOutcomes.handleLoopError(input, error, signal);
    } finally {
      // Always end the trace and clean up plan version counter (§P0-2)
      if (this.deps.traceManager) {
        this.deps.traceManager.endTrace(input.runId);
      }
      this._cleanupPlanVersion(input.runId);
    }
  }

  // ── Phase methods ──────────────────────────────────────────────────

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
    /** §P1-1: Pre-created stream from run() for early progress status.
     *  When provided, status/thinking parts are already on the stream and
     *  content blocks are appended here. When absent, a new stream is
     *  created (backward-compatible fallback for approval/resume paths). */
    existingStream?: AssistantMessageStream,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    // Approval-required tools go through the content-block stream with
    // saved partsSnapshot + pendingToolCall for resume.
    if (decision.type === "use_tool") {
      const hasApprovalRequired = decision.toolCalls.some(
        (tc) => tc.requiresApproval,
      );
      if (hasApprovalRequired) {
        return this.approvalFlow.runApprovalForToolCalls(
          input, context, intent, plan, decision, messageId, signal,
        );
      }
    }

    // §P1-1: Use pre-created stream when available (from run()), otherwise
    // create a new one. Pre-inference text is never written to this stream.
    const stream = existingStream ?? (() => {
      const s = new AssistantMessageStream({
        runId,
        conversationId,
        messageId,
        eventBus: this.deps.eventBus,
        saveMessage: this.deps.saveMessage!,
        skipStartedEvents: true,
      });
      s.start();
      return s;
    })();

    try {
      let assistantMessageId: string;
      let artifacts: import("./loop-types.js").ArtifactRef[] = [];
      let toolCalls: import("./loop-types.js").ToolCallSummary[] = [];

      if (decision.type === "use_tool") {
        // Tool path: LLM native function calling loop
        await this.deps.runStateManager.markStatus(runId, "executing");

        // §P0-7: Create tool_executing span for phase timing trace
        const toolSpan = this._startSpan(runId, "tool_executing");

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

        // §P0-7: Emit phase timing metrics on tool execution span
        toolSpan?.endSpan(
          `Tool execution: ${result.toolCalls.length} tool calls, ${result.artifacts.length} artifacts`,
          {
            toolCalls: result.toolCalls.length,
            // Phase-level timing breakdown mapped to SpanMetrics fields
            toolRetrievalMs: result.timing.toolRetrievalMs,
            firstTokenMs: result.timing.firstRoundFirstTokenMs,
            toolExecutionMs: result.timing.totalToolExecutionMs,
            finalTokenMs: result.timing.finalRoundFirstTokenMs,
          },
        );

        assistantMessageId = result.messageId;
        artifacts = result.artifacts;
        toolCalls = result.toolCalls;
      } else if (decision.type === "no_tool") {
        // no_tool path: direct LLM response via ResponseComposer with stream
        // §P0-1: Direct response is the final answer.
        await this.deps.runStateManager.markStatus(runId, "responding");

        const textPart = stream.startTextPart("final");
        await this.deps.responseComposer.composeDirect(
          {
            input,
            context,
            intent,
            plan,
            modelId: input.modelId,
            stream: { stream: stream, textPartId: textPart.id },
          },
          signal,
        );
        stream.completeTextPart(textPart.id);
        assistantMessageId = messageId;
      }

      // Complete the stream (saves message, emits completion events)
      const completed = await stream.complete();

      // §Write memories — await with retry from the wrapper, don't block response
      const tokenRatio = context.limits.usedTokensEstimate / Math.max(1, context.limits.maxTokens);
      try {
        await this.runOutcomes.writeMemories({
          input,
          context,
          intent,
          plan,
          responseMessageId: messageId,
          observation: toolCalls.length > 0
            ? { runId, toolCalls, artifacts, summary: toolCalls.map((t) => t.summary).join("\n") }
            : undefined,
          // Trigger summary every ~20 messages (pure-chat convos never hit
          // token/tool thresholds). The memory writer's extractCandidates
          // will generate a conversation_summary that replaces old history.
          forceSummary: tokenRatio > 0.4 || toolCalls.length >= 15
            || context.messages.length >= 20,
        });
      } catch (err) {
        // Memory write failed even after retries — logged by MemoryRetryWrapper
        this.deps.eventBus.emit(
          "agent.error",
          {
            runId,
            code: "AGENT_MEMORY_WRITE_FAILED",
            message: `Memory write failed: ${err instanceof Error ? err.message : String(err)}`,
            category: "memory",
            retryable: false,
          },
          { runId, conversationId },
        );
      }

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
            label: RUN_PHASE_LABELS.stopped,
            metadata: { phase: "completed" },
          });
          const stopText = stream.startTextPart("final");
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
    return this.approvalContinuation.continueAfterRejection(input, signal);
  }

  async resumeApprovedTool(
    approval: ApprovalResumeInput,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    return this.approvalContinuation.resumeApprovedTool(approval, signal);
  }


}