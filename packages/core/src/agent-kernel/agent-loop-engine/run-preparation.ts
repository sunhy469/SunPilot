import type {
  AgentContext,
  AgentLoopInput,
  AgentObservation,
  AgentPlan,
  PreliminaryInferenceResult,
  RoutedIntent,
  ToolDecision,
} from "../loop-types.js";
import type { SpanKind, SpanMetrics } from "../trace-manager.js";
import type { AgentLoopEngineDeps } from "../agent-loop-engine.js";
import { peekResolvedPromise } from "./utils.js";

export type PhaseSpanStarter = (
  runId: string,
  kind: SpanKind,
  parentSpanId?: string,
) => {
  spanId: string;
  endSpan: (summary: string, metrics?: SpanMetrics, error?: string) => void;
} | null;

/** Builds the context, resolves intent, and prepares the plan/tool decision. */
export class RunPreparationCoordinator {
  constructor(
    private readonly deps: AgentLoopEngineDeps,
    private readonly startSpan: PhaseSpanStarter,
    private readonly nextPlanVersion: (runId: string) => number,
  ) {}

  /** 阶段 1+2：上下文构建 + 意图路由。
   *  §P3 opt: Accepts optional pre-inference promise. After context building,
   *  awaits the pre-inference with a timeout and uses its result to skip
   *  IntentRouter Layer 2 when available. */
  async buildContextAndIntent(
    input: AgentLoopInput,
    signal: AbortSignal,
    preInference?: { intentType?: string; intentConfidence?: number },
    preInferencePromise?: Promise<PreliminaryInferenceResult | undefined>,
  ): Promise<{ context: AgentContext; intent: RoutedIntent }> {
    const { runId, conversationId } = input;

    // ── Context building span (§P1-5) ──
    const ctxSpan = this.startSpan(runId, "context_building");
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
        // §P0-3: Phase latency metrics for observability
        latencyMs: Date.now() - ctxStart,
        contextGroupAMs: context.timing?.groupAParallelMs,
        summaryGenerationMs: context.timing?.summaryGenerationMs,
        summaryProcessingMs: context.timing?.summaryProcessingMs,
        historyProcessingMs: context.timing?.historyProcessingMs,
        memorySearchMs: context.timing?.memorySearchMs,
        sourceCompressionMs: context.timing?.sourceCompressionMs,
        tokenBudgetMs: context.timing?.tokenBudgetMs,
        contextAssemblyMs: context.timing?.contextAssemblyMs,
      },
    );

    // §3.2/§6.1: Pre-inference RACE — do NOT block on pre-inference here.
    // Pre-inference runs concurrently with context building. By the time
    // context is built, it MAY have resolved. We do a non-blocking peek
    // (0ms race): if it's ready, use it to skip Layer 2; if not, proceed
    // with the full IntentRouter.route() without waiting. This ensures
    // pre-inference never adds latency to the critical path.
    let preInferenceResult: { intentType?: string; intentConfidence?: number } | undefined = preInference;
    if (preInferencePromise) {
      const prelimStart = Date.now();
      // §3.2: Non-blocking peek — resolves immediately with undefined if
      // pre-inference hasn't completed yet.
      const resolved = await peekResolvedPromise(preInferencePromise);
      if (resolved) {
        preInferenceResult = {
          intentType: resolved.intentType,
          intentConfidence: resolved.intentConfidence,
        };
        if (this.deps.traceManager) {
          const waitMs = Date.now() - prelimStart;
          const { endSpan } = this.deps.traceManager.startSpan(runId, "pre_inference_await");
          endSpan("pre_inference_resolved_inline", {
            latencyMs: waitMs,
            preInferenceLatencyMs: waitMs,
            preInferenceIntentType: preInferenceResult.intentType,
            preInferenceConfidence: preInferenceResult.intentConfidence,
          });
        }
      } else {
        // §3.2: Pre-inference not yet ready — record as "skipped" so
        // operators can see how often pre-inference misses the window.
        if (this.deps.traceManager) {
          const waitMs = Date.now() - prelimStart;
          const { endSpan } = this.deps.traceManager.startSpan(runId, "pre_inference_await");
          endSpan("pre_inference_not_ready", {
            latencyMs: waitMs,
            preInferenceTimeoutMs: 0,
          });
        }
      }
    }

    // ── Intent routing span (§P1-5) ──
    const intentSpan = this.startSpan(
      runId,
      "intent_routing",
      ctxSpan?.spanId,
    );

    await this.deps.runStateManager.markStatus(runId, "intent_routing");
    const intentStart = Date.now();
    let intent: RoutedIntent;
    try {
      // §P3 opt: When pre-inference already classified the intent (confidence ≥ 0.7),
      // use routeWithPreInference to skip Layer 2 LLM call.
      if (preInferenceResult?.intentType && this.deps.intentRouter.routeWithPreInference) {
        intent = await this.deps.intentRouter.routeWithPreInference(
          context,
          signal,
          preInferenceResult,
        );
      } else {
        intent = await this.deps.intentRouter.route(context, signal);
      }
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
        // §P0-3: Phase latency metrics for observability
        intentRouteMs: Date.now() - intentStart,
        // §P3: Routing layer for debugging which layer decided the intent
        routingLayer: intent.trace?.routingLayer,
        preInferenceUsed: preInferenceResult?.intentType ? "true" : "false",
        // Trace metadata for debugging tool selection (§P2):
        // embedding mode, top similarity score, form-match flag
        embeddingMode: intent.trace?.embeddingMode,
        embeddingTopScore: intent.trace?.embeddingTopScore,
        embeddingCandidateCount: intent.trace?.embeddingCandidateCount,
        formMatch: intent.trace?.formMatch,
        // §P0-3: Per-layer timing breakdown for intent routing
        layer0FormMatchMs: intent.trace?.layer0FormMatchMs,
        layer1QueryEmbedMs: intent.trace?.layer1QueryEmbedMs,
        layer1SkillEmbedMs: intent.trace?.layer1SkillEmbedMs,
        layer2LlmMs: intent.trace?.layer2LlmMs,
        layer2TtftMs: intent.trace?.layer2TtftMs,
      },
    );

    return { context, intent };
  }

  /** 阶段 3：规划（仅在意图需要时）。 */
  async maybeCreatePlan(
    input: AgentLoopInput,
    context: AgentContext,
    intent: RoutedIntent,
    signal: AbortSignal,
  ): Promise<AgentPlan | undefined> {
    if (!intent.requiresPlanning) return undefined;

    const { runId, conversationId } = input;
    const planSpan = this.startSpan(runId, "planning");

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
      const version = this.nextPlanVersion(runId);
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
  async decideTools(
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
    const toolSpan = this.startSpan(input.runId, "tool_deciding");
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
}
