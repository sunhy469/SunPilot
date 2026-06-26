/**
 * Trace/Span Manager — unified observability layer (§7 of architecture next steps).
 *
 * Provides trace IDs that span across runs, model calls, tool calls,
 * approvals, and memory writes. Defines spans for each phase of the
 * Agent Loop so latency, token usage, and errors can be tracked per-phase.
 */

// ── Trace & Span Types ───────────────────────────────────────────────────

export type SpanKind =
  | "context_building"
  | "intent_routing"
  | "planning"
  | "tool_deciding"
  | "tool_executing"
  | "reflecting"
  | "responding"
  | "memory_writing"
  | "approval_handling"
  | "pre_inference_await";

export interface SpanTiming {
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface SpanMetrics {
  tokenInput?: number;
  tokenOutput?: number;
  toolCalls?: number;
  toolFailures?: number;
  approvalRequired?: boolean;
  modelCalls?: number;
  /** IDs of model calls made during this span, for trace-to-model-call linking (§P1-5). */
  modelCallIds?: string[];
  retryCount?: number;
  errorCode?: string;
  // ── Phase latency metrics (§P0-3) ───────────────────────────────
  /** Total milliseconds for this span (duration). */
  latencyMs?: number;
  /** Sub-phase timings for detailed observability (§P0-3). */
  contextGroupAMs?: number;
  summaryGenerationMs?: number;
  summaryProcessingMs?: number;
  historyProcessingMs?: number;
  memorySearchMs?: number;
  sourceCompressionMs?: number;
  tokenBudgetMs?: number;
  contextAssemblyMs?: number;
  intentRouteMs?: number;
  // §P0-3: Per-layer timing breakdown for intent routing
  layer0FormMatchMs?: number;
  layer1QueryEmbedMs?: number;
  layer1SkillEmbedMs?: number;
  layer2LlmMs?: number;
  layer2TtftMs?: number;
  toolRetrievalMs?: number;
  firstTokenMs?: number;
  toolExecutionMs?: number;
  finalTokenMs?: number;
  // ── Tool selection trace metadata (§P2) ─────────────────────────
  /** Embedding mode: "real" | "lexical_fallback" | "none". */
  embeddingMode?: string;
  /** Top embedding similarity score from intent routing. */
  embeddingTopScore?: number;
  /** Number of skills considered in embedding pass. */
  embeddingCandidateCount?: number;
  /** Whether intent was determined by form-match rules. */
  formMatch?: boolean;
  /** Tool decision path (plan/intent_match/deterministic_scorer/llm_semantic/scorer_fallback). */
  decisionPath?: string;
  /** Top-K value from tool retrieval. */
  retrievalTopK?: number;
  /** Number of candidates in retrieval result. */
  retrievalCandidateCount?: number;
  /** Whether retrieval fell back to broader search. */
  retrievalFallback?: boolean;
  // ── §P3: Pre-inference observability metrics ───────────────────
  /** Intent type from pre-inference classification. */
  preInferenceIntentType?: string;
  /** Confidence score from pre-inference (0-1). */
  preInferenceConfidence?: number;
  /** Wall-clock latency of the pre-inference LLM call (ms). */
  preInferenceLatencyMs?: number;
  /** Error message if pre-inference failed. */
  preInferenceError?: string;
  /** Timeout duration if pre-inference was cut short (ms). */
  preInferenceTimeoutMs?: number;
  /** Which routing layer decided the final intent. */
  routingLayer?: string;
  /** Whether pre-inference result was used to skip Layer 2. */
  preInferenceUsed?: string;
}

export interface Span {
  /** Unique span ID. */
  spanId: string;
  /** Parent trace ID. */
  traceId: string;
  /** Parent span ID (for nested spans). */
  parentSpanId?: string;
  /** What phase of the agent loop this span represents. */
  kind: SpanKind;
  /** Timing information. */
  timing: SpanTiming;
  /** Human-readable summary of what happened in this span. */
  summary: string;
  /** Key metrics collected during this span. */
  metrics: SpanMetrics;
  /** Any errors that occurred in this span. */
  error?: string;
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
}

export interface Trace {
  /** Unique trace ID (ties together all spans for one agent run). */
  traceId: string;
  /** The run ID this trace belongs to. */
  runId: string;
  /** Conversation ID. */
  conversationId?: string;
  /** When the trace started. */
  startedAt: string;
  /** When the trace ended (or undefined if still in progress). */
  endedAt?: string;
  /** All spans in this trace, ordered by start time. */
  spans: Span[];
  /** Aggregate metrics across all spans. */
  aggregate: TraceAggregate;
}

export interface TraceAggregate {
  totalDurationMs: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalToolCalls: number;
  totalToolFailures: number;
  totalModelCalls: number;
  totalErrors: number;
  spanKindBreakdown: Record<string, { count: number; totalDurationMs: number }>;
}

// ── Aggregated Metrics ───────────────────────────────────────────────────

export interface KeyMetrics {
  /** Tool call success rate (0–1). */
  toolCallSuccessRate: number;
  /** Parameter repair rate (0–1). */
  parameterRepairRate: number;
  /** Approval pass/reject rate. */
  approvalPassRate: number;
  /** Early stop rate (0–1), or null when no signal is available. */
  earlyStopRate: number | null;
  /** Memory hit rate (how often recalled memories were relevant), or null when no signal is available. */
  memoryHitRate: number | null;
  /** Average latency per phase. */
  avgLatencyByPhase: Record<string, number>;
  /** Token usage by purpose. */
  tokenUsageByPurpose: Record<string, { input: number; output: number }>;
}

/**
 * TraceManager — creates and manages traces/spans for agent observability.
 *
 * Design (§7):
 * - One trace per agent run, spanning all phases
 * - Spans for each distinct phase of the Agent Loop
 * - Metrics collected per-span and aggregated at trace level
 * - Enables debugging: trace an anomalous response back to specific
 *   context, tool result, reflection, or memory recall
 */
export class TraceManager {
  private readonly activeTraces = new Map<string, Trace>();
  private readonly completedTraces: Trace[] = [];
  private readonly maxCompletedTraces: number;

  constructor(maxCompletedTraces = 1000) {
    this.maxCompletedTraces = maxCompletedTraces;
  }

  /**
   * Start a new trace for an agent run.
   */
  startTrace(runId: string, conversationId?: string): Trace {
    const traceId = `trace_${runId}_${Date.now()}`;
    const trace: Trace = {
      traceId,
      runId,
      conversationId,
      startedAt: new Date().toISOString(),
      spans: [],
      aggregate: {
        totalDurationMs: 0,
        totalTokenInput: 0,
        totalTokenOutput: 0,
        totalToolCalls: 0,
        totalToolFailures: 0,
        totalModelCalls: 0,
        totalErrors: 0,
        spanKindBreakdown: {},
      },
    };
    this.activeTraces.set(runId, trace);
    return trace;
  }

  /**
   * Start a new span within a trace.
   * Returns a function to call when the span ends.
   */
  startSpan(
    runId: string,
    kind: SpanKind,
    parentSpanId?: string,
  ): { spanId: string; endSpan: (summary: string, metrics?: SpanMetrics, error?: string) => Span } {
    const trace = this.activeTraces.get(runId);
    if (!trace) {
      throw new Error(`No active trace for run ${runId}. Call startTrace first.`);
    }

    const spanId = `span_${kind}_${crypto.randomUUID().slice(0, 8)}`;
    const startMs = Date.now();

    const endSpan = (
      summary: string,
      metrics: SpanMetrics = {},
      error?: string,
    ): Span => {
      const endMs = Date.now();
      const span: Span = {
        spanId,
        traceId: trace.traceId,
        parentSpanId,
        kind,
        timing: {
          startMs,
          endMs,
          durationMs: endMs - startMs,
        },
        summary,
        metrics,
        error,
        metadata: {
          runId,
          conversationId: trace.conversationId,
        },
      };

      trace.spans.push(span);

      // Update aggregate
      trace.aggregate.totalDurationMs = Math.max(
        trace.aggregate.totalDurationMs,
        endMs - new Date(trace.startedAt).getTime(),
      );
      trace.aggregate.totalTokenInput += metrics.tokenInput ?? 0;
      trace.aggregate.totalTokenOutput += metrics.tokenOutput ?? 0;
      trace.aggregate.totalToolCalls += metrics.toolCalls ?? 0;
      trace.aggregate.totalToolFailures += metrics.toolFailures ?? 0;
      trace.aggregate.totalModelCalls += metrics.modelCalls ?? 0;
      if (error) trace.aggregate.totalErrors += 1;

      const kindStats = trace.aggregate.spanKindBreakdown[kind] ?? {
        count: 0,
        totalDurationMs: 0,
      };
      kindStats.count += 1;
      kindStats.totalDurationMs += span.timing.durationMs;
      trace.aggregate.spanKindBreakdown[kind] = kindStats;

      return span;
    };

    return { spanId, endSpan };
  }

  /**
   * End a trace and move it to the completed list.
   */
  endTrace(runId: string): Trace | undefined {
    const trace = this.activeTraces.get(runId);
    if (!trace) return undefined;

    trace.endedAt = new Date().toISOString();
    // §P0-3: Record the real total turn duration (startTrace → endTrace),
    // not just the max span duration. This is the authoritative total_turn_ms.
    trace.aggregate.totalDurationMs =
      Date.now() - new Date(trace.startedAt).getTime();
    this.activeTraces.delete(runId);
    this.completedTraces.push(trace);

    // Prune old traces
    while (this.completedTraces.length > this.maxCompletedTraces) {
      this.completedTraces.shift();
    }

    return trace;
  }

  /**
   * Get an active trace by run ID.
   */
  getTrace(runId: string): Trace | undefined {
    return (
      this.activeTraces.get(runId) ??
      this.completedTraces.find((t) => t.runId === runId)
    );
  }

  /**
   * Get all active trace IDs.
   */
  getActiveTraceIds(): string[] {
    return Array.from(this.activeTraces.keys());
  }

  /**
   * Compute key metrics from all completed traces.
   */
  computeKeyMetrics(): KeyMetrics {
    const allSpans = this.completedTraces.flatMap((t) => t.spans);

    // Tool call success rate
    const toolExecSpans = allSpans.filter(
      (s) => s.kind === "tool_executing",
    );
    const totalToolCalls = toolExecSpans.reduce(
      (sum, s) => sum + (s.metrics.toolCalls ?? 0),
      0,
    );
    const totalToolFailures = toolExecSpans.reduce(
      (sum, s) => sum + (s.metrics.toolFailures ?? 0),
      0,
    );
    const toolCallSuccessRate =
      totalToolCalls > 0
        ? (totalToolCalls - totalToolFailures) / totalToolCalls
        : 1;

    // Parameter repair rate (heuristic: retries > 0 means repair was needed)
    const repairSpans = toolExecSpans.filter(
      (s) => (s.metrics.retryCount ?? 0) > 0,
    );
    const parameterRepairRate =
      toolExecSpans.length > 0
        ? repairSpans.length / toolExecSpans.length
        : 0;

    // Approval pass rate
    const approvalSpans = allSpans.filter(
      (s) => s.kind === "approval_handling",
    );
    const approvalsRequired = approvalSpans.filter(
      (s) => s.metrics.approvalRequired,
    ).length;
    const approvalPassRate =
      approvalSpans.length > 0
        ? (approvalSpans.length - approvalsRequired) / approvalSpans.length
        : 1;

    // Average latency by phase — §B5: track running sum and count so the
    // average is exact rather than the previous (existing+new)/2 rolling
    // average that over-weighted recent spans.
    const latencySumByPhase: Record<string, number> = {};
    const latencyCountByPhase: Record<string, number> = {};
    for (const span of allSpans) {
      latencySumByPhase[span.kind] =
        (latencySumByPhase[span.kind] ?? 0) + span.timing.durationMs;
      latencyCountByPhase[span.kind] =
        (latencyCountByPhase[span.kind] ?? 0) + 1;
    }
    const avgLatencyByPhase: Record<string, number> = {};
    for (const kind of Object.keys(latencySumByPhase)) {
      const sum = latencySumByPhase[kind]!;
      const count = latencyCountByPhase[kind]!;
      avgLatencyByPhase[kind] = count > 0 ? sum / count : 0;
    }

    // Token usage by purpose
    const tokenUsageByPurpose: Record<
      string,
      { input: number; output: number }
    > = {};
    for (const span of allSpans) {
      const purpose =
        (span.metadata?.["purpose"] as string) ?? span.kind;
      if (!tokenUsageByPurpose[purpose]) {
        tokenUsageByPurpose[purpose] = { input: 0, output: 0 };
      }
      tokenUsageByPurpose[purpose]!.input +=
        span.metrics.tokenInput ?? 0;
      tokenUsageByPurpose[purpose]!.output +=
        span.metrics.tokenOutput ?? 0;
    }

    // Early stop rate (tasks completed without executing all planned tool steps).
    // §B21: no span currently carries a "planned vs executed step" signal, so
    // we cannot compute a real value. Return null to signal "unknown" rather
    // than the misleading hardcoded 0 (which falsely reports 0% early stops).
    const earlyStopRate: number | null = null;

    // Memory hit rate — how often recalled memories were relevant.
    // §B21: requires a relevance signal from the context builder that is not
    // recorded on any span today. Return null instead of a fake 0.
    const memoryHitRate: number | null = null;

    return {
      toolCallSuccessRate,
      parameterRepairRate,
      approvalPassRate,
      earlyStopRate,
      memoryHitRate,
      avgLatencyByPhase,
      tokenUsageByPurpose,
    };
  }

  /**
   * Clear all traces (e.g., between test runs).
   */
  clear(): void {
    this.activeTraces.clear();
    this.completedTraces.length = 0;
  }

  /**
   * Export trace data for debugging or external analysis.
   */
  exportTrace(runId: string): Trace | undefined {
    const trace = this.getTrace(runId);
    if (!trace) return undefined;

    // Deep clone to avoid mutation
    return JSON.parse(JSON.stringify(trace)) as Trace;
  }

  /**
   * Summarize a trace for human-readable debugging output.
   */
  summarizeTrace(runId: string): string {
    const trace = this.getTrace(runId);
    if (!trace) return `No trace found for run ${runId}`;

    const lines = [
      `Trace: ${trace.traceId}`,
      `Run: ${trace.runId}`,
      `Started: ${trace.startedAt}`,
      `Ended: ${trace.endedAt ?? "in progress"}`,
      `Spans: ${trace.spans.length}`,
      `Total duration: ${trace.aggregate.totalDurationMs}ms`,
      `Total tokens: ${trace.aggregate.totalTokenInput} in / ${trace.aggregate.totalTokenOutput} out`,
      `Tool calls: ${trace.aggregate.totalToolCalls} (${trace.aggregate.totalToolFailures} failed)`,
      `Model calls: ${trace.aggregate.totalModelCalls}`,
      `Errors: ${trace.aggregate.totalErrors}`,
      "",
      "Spans:",
    ];

    for (const span of trace.spans) {
      const errorMark = span.error ? " ❌" : "";
      lines.push(
        `  ${span.kind}: ${span.timing.durationMs}ms — ${span.summary.slice(0, 80)}${errorMark}`,
      );
    }

    return lines.join("\n");
  }
}
