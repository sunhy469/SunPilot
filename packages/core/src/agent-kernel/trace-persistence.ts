/**
 * RepositoryTraceManager — persistent trace/span manager.
 *
 * Wraps the in-memory TraceManager and persists every trace and span
 * to the database via AgentTraceRepository. This makes traces survive
 * daemon restarts and enables cross-run debugging.
 *
 * Architecture doc: agent_architecture_next_steps.md §P0-2
 */

import type { AgentTraceRepository, SpanRecord } from "@sunpilot/storage";
import type { SpanKind } from "./trace-manager.js";
import {
  TraceManager,
  type Trace,
  type Span,
  type SpanMetrics,
  type KeyMetrics,
} from "./trace-manager.js";

// ── Persistence Adapter ───────────────────────────────────────────────────

/**
 * Thin adapter that persists trace/span operations to the database
 * alongside in-memory operations in the TraceManager.
 *
 * DB writes are fire-and-forget — they do not block the agent loop.
 * Failures are silently caught to prevent DB issues from crashing runs.
 */
export class RepositoryTraceManager {
  private readonly memory: TraceManager;

  constructor(
    private readonly traceRepo: AgentTraceRepository,
    maxCompletedTraces = 1000,
  ) {
    this.memory = new TraceManager(maxCompletedTraces);
  }

  /** Start a trace and persist initial record. */
  startTrace(runId: string, conversationId?: string): Trace {
    const trace = this.memory.startTrace(runId, conversationId);

    // Fire-and-forget: persist trace to DB
    this.traceRepo
      .createTrace({
        id: trace.traceId,
        runId: trace.runId,
        conversationId: trace.conversationId,
        startedAt: trace.startedAt,
      })
      .catch(() => {
        // Best effort — don't block agent loop on DB errors
      });

    return trace;
  }

  /** Start a span (in-memory) and persist initial record. */
  startSpan(
    runId: string,
    kind: SpanKind,
    parentSpanId?: string,
  ): { spanId: string; endSpan: (summary: string, metrics?: SpanMetrics, error?: string) => Span } {
    const { spanId, endSpan: originalEnd } = this.memory.startSpan(runId, kind, parentSpanId);

    const trace = this.memory.getTrace(runId);
    if (trace) {
      // Persist initial span record
      this.traceRepo
        .createSpan({
          id: spanId,
          traceId: trace.traceId,
          parentSpanId,
          runId,
          kind,
          startMs: Date.now(),
        })
        .catch(() => {
          // Best effort
        });
    }

    // Wrap endSpan to also update DB
    const endSpan = (summary: string, metrics: SpanMetrics = {}, error?: string): Span => {
      const span = originalEnd(summary, metrics, error);

      // Merge modelCallIds and sub-phase timing into span metadata
      // for DB persistence (§P0-3). The metadata JSONB column carries
      // phase-level timing so the frontend debug panel can display
      // per-phase latency breakdown.
      span.metadata = {
        ...(span.metadata ?? {}),
        ...(metrics.modelCallIds ? { modelCallIds: metrics.modelCallIds } : {}),
        // §P0-3: Sub-phase timing for debug panel
        ...(metrics.contextGroupAMs !== undefined ? { contextGroupAMs: metrics.contextGroupAMs } : {}),
        ...(metrics.memorySearchMs !== undefined ? { memorySearchMs: metrics.memorySearchMs } : {}),
        ...(metrics.intentRouteMs !== undefined ? { intentRouteMs: metrics.intentRouteMs } : {}),
        ...(metrics.toolRetrievalMs !== undefined ? { toolRetrievalMs: metrics.toolRetrievalMs } : {}),
        ...(metrics.firstTokenMs !== undefined ? { firstTokenMs: metrics.firstTokenMs } : {}),
        ...(metrics.toolExecutionMs !== undefined ? { toolExecutionMs: metrics.toolExecutionMs } : {}),
        ...(metrics.finalTokenMs !== undefined ? { finalTokenMs: metrics.finalTokenMs } : {}),
      };

      // Update span in DB with completed data
      this.traceRepo
        .createSpan({
          id: span.spanId,
          traceId: span.traceId,
          parentSpanId: span.parentSpanId,
          runId,
          kind: span.kind,
          summary: span.summary,
          startMs: span.timing.startMs,
          endMs: span.timing.endMs,
          durationMs: span.timing.durationMs,
          tokenInput: metrics.tokenInput,
          tokenOutput: metrics.tokenOutput,
          toolCallsCount: metrics.toolCalls,
          toolFailures: metrics.toolFailures,
          modelCallsCount: metrics.modelCalls,
          retryCount: metrics.retryCount,
          approvalRequired: metrics.approvalRequired,
          error,
          errorCode: metrics.errorCode,
          metadata: span.metadata,
        })
        .catch(() => {
          // Best effort
        });

      return span;
    };

    return { spanId, endSpan };
  }

  /** End trace and update DB with final aggregate. */
  endTrace(runId: string): Trace | undefined {
    const trace = this.memory.endTrace(runId);
    if (!trace) return undefined;

    // Update DB with final aggregate
    this.traceRepo
      .createTrace({
        id: trace.traceId,
        runId: trace.runId,
        conversationId: trace.conversationId,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        totalDurationMs: trace.aggregate.totalDurationMs,
        totalTokenInput: trace.aggregate.totalTokenInput,
        totalTokenOutput: trace.aggregate.totalTokenOutput,
        totalToolCalls: trace.aggregate.totalToolCalls,
        totalToolFailures: trace.aggregate.totalToolFailures,
        totalModelCalls: trace.aggregate.totalModelCalls,
        totalErrors: trace.aggregate.totalErrors,
        spanCount: trace.spans.length,
      })
      .catch(() => {
        // Best effort
      });

    return trace;
  }

  /** Get trace from memory (fast path). */
  getTrace(runId: string): Trace | undefined {
    return this.memory.getTrace(runId);
  }

  /** Export trace for debugging. Falls back to in-memory data. */
  exportTrace(runId: string): Trace | undefined {
    return this.memory.exportTrace(runId);
  }

  /** Summarize trace for human-readable output. */
  summarizeTrace(runId: string): string {
    return this.memory.summarizeTrace(runId);
  }

  /** Compute key metrics from in-memory data. */
  computeKeyMetrics(): KeyMetrics {
    return this.memory.computeKeyMetrics();
  }

  /** Clear in-memory data (not DB). */
  clear(): void {
    this.memory.clear();
  }

  /** Load a trace from DB (for daemon restart recovery). */
  async loadTraceFromDb(runId: string): Promise<Trace | undefined> {
    const dbTrace = await this.traceRepo.findByRunId(runId);
    if (!dbTrace) return undefined;

    const dbSpans = await this.traceRepo.listSpansByRunId(runId);

    const spans: Span[] = dbSpans.map((s: SpanRecord) => ({
      spanId: s.id,
      traceId: s.traceId,
      parentSpanId: s.parentSpanId,
      kind: s.kind as SpanKind,
      timing: {
        startMs: s.startMs,
        endMs: s.endMs ?? s.startMs,
        durationMs: s.durationMs ?? 0,
      },
      summary: s.summary ?? "",
      metrics: {
        tokenInput: s.tokenInput,
        tokenOutput: s.tokenOutput,
        toolCalls: s.toolCallsCount,
        toolFailures: s.toolFailures,
        modelCalls: s.modelCallsCount,
        retryCount: s.retryCount,
        approvalRequired: s.approvalRequired,
        errorCode: s.errorCode,
      },
      error: s.error,
      metadata: s.metadata,
    }));

    const trace: Trace = {
      traceId: dbTrace.id,
      runId: dbTrace.runId,
      conversationId: dbTrace.conversationId,
      startedAt: dbTrace.startedAt,
      endedAt: dbTrace.endedAt,
      spans,
      aggregate: {
        totalDurationMs: dbTrace.totalDurationMs ?? 0,
        totalTokenInput: dbTrace.totalTokenInput ?? 0,
        totalTokenOutput: dbTrace.totalTokenOutput ?? 0,
        totalToolCalls: dbTrace.totalToolCalls ?? 0,
        totalToolFailures: dbTrace.totalToolFailures ?? 0,
        totalModelCalls: dbTrace.totalModelCalls ?? 0,
        totalErrors: dbTrace.totalErrors ?? 0,
        spanKindBreakdown: {},
      },
    };

    // Compute span kind breakdown
    for (const span of spans) {
      const key = span.kind;
      if (!trace.aggregate.spanKindBreakdown[key]) {
        trace.aggregate.spanKindBreakdown[key] = { count: 0, totalDurationMs: 0 };
      }
      trace.aggregate.spanKindBreakdown[key]!.count += 1;
      trace.aggregate.spanKindBreakdown[key]!.totalDurationMs += span.timing.durationMs;
    }

    return trace;
  }
}
