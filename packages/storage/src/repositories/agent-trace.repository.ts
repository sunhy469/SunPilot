/**
 * Agent Trace repository — persists trace and span data for agent observability.
 * Architecture doc: agent_architecture_next_steps.md §P0-2
 */

import type { PostgresPool } from "../postgres/postgres.client.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface CreateTraceInput {
  id: string;
  runId: string;
  conversationId?: string;
  startedAt: string;
  endedAt?: string;
  totalDurationMs?: number;
  totalTokenInput?: number;
  totalTokenOutput?: number;
  totalToolCalls?: number;
  totalToolFailures?: number;
  totalModelCalls?: number;
  totalErrors?: number;
  spanCount?: number;
}

export interface TraceRecord extends CreateTraceInput {
  createdAt: string;
}

export interface CreateSpanInput {
  id: string;
  traceId: string;
  parentSpanId?: string;
  runId: string;
  kind: string;
  summary?: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  tokenInput?: number;
  tokenOutput?: number;
  toolCallsCount?: number;
  toolFailures?: number;
  modelCallsCount?: number;
  retryCount?: number;
  approvalRequired?: boolean;
  error?: string;
  errorCode?: string;
  metadata?: Record<string, unknown>;
}

export interface SpanRecord extends CreateSpanInput {
  createdAt: string;
}

// ── Repository ────────────────────────────────────────────────────────────

export class AgentTraceRepository {
  constructor(private readonly pool: PostgresPool) {}

  async createTrace(input: CreateTraceInput): Promise<TraceRecord> {
    const result = await this.pool.query(
      `INSERT INTO agent_traces (
        id, run_id, conversation_id, started_at, ended_at,
        total_duration_ms, total_token_input, total_token_output,
        total_tool_calls, total_tool_failures, total_model_calls,
        total_errors, span_count
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (id) DO UPDATE SET
        ended_at = EXCLUDED.ended_at,
        total_duration_ms = EXCLUDED.total_duration_ms,
        total_token_input = EXCLUDED.total_token_input,
        total_token_output = EXCLUDED.total_token_output,
        total_tool_calls = EXCLUDED.total_tool_calls,
        total_tool_failures = EXCLUDED.total_tool_failures,
        total_model_calls = EXCLUDED.total_model_calls,
        total_errors = EXCLUDED.total_errors,
        span_count = EXCLUDED.span_count
      RETURNING created_at`,
      [
        input.id,
        input.runId,
        input.conversationId ?? null,
        input.startedAt,
        input.endedAt ?? null,
        input.totalDurationMs ?? 0,
        input.totalTokenInput ?? 0,
        input.totalTokenOutput ?? 0,
        input.totalToolCalls ?? 0,
        input.totalToolFailures ?? 0,
        input.totalModelCalls ?? 0,
        input.totalErrors ?? 0,
        input.spanCount ?? 0,
      ],
    );
    const createdAt = result.rows[0]?.created_at as string;
    return { ...input, createdAt };
  }

  async findByRunId(runId: string): Promise<TraceRecord | null> {
    const result = await this.pool.query(
      `SELECT id, run_id, conversation_id, started_at, ended_at,
              total_duration_ms, total_token_input, total_token_output,
              total_tool_calls, total_tool_failures, total_model_calls,
              total_errors, span_count, created_at
       FROM agent_traces WHERE run_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [runId],
    );
    if (result.rows.length === 0) return null;
    return rowToTrace(result.rows[0]);
  }

  async findById(id: string): Promise<TraceRecord | null> {
    const result = await this.pool.query(
      `SELECT id, run_id, conversation_id, started_at, ended_at,
              total_duration_ms, total_token_input, total_token_output,
              total_tool_calls, total_tool_failures, total_model_calls,
              total_errors, span_count, created_at
       FROM agent_traces WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return null;
    return rowToTrace(result.rows[0]);
  }

  // ── Spans ───────────────────────────────────────────────────────────

  async createSpan(input: CreateSpanInput): Promise<SpanRecord> {
    const result = await this.pool.query(
      `INSERT INTO agent_trace_spans (
        id, trace_id, parent_span_id, run_id, kind, summary,
        start_ms, end_ms, duration_ms,
        token_input, token_output,
        tool_calls_count, tool_failures, model_calls_count,
        retry_count, approval_required,
        error, error_code, metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (id) DO UPDATE SET
        end_ms = EXCLUDED.end_ms,
        duration_ms = EXCLUDED.duration_ms,
        summary = EXCLUDED.summary,
        error = EXCLUDED.error,
        error_code = EXCLUDED.error_code,
        metadata = EXCLUDED.metadata
      RETURNING created_at`,
      [
        input.id,
        input.traceId,
        input.parentSpanId ?? null,
        input.runId,
        input.kind,
        input.summary ?? null,
        input.startMs,
        input.endMs ?? null,
        input.durationMs ?? null,
        input.tokenInput ?? 0,
        input.tokenOutput ?? 0,
        input.toolCallsCount ?? 0,
        input.toolFailures ?? 0,
        input.modelCallsCount ?? 0,
        input.retryCount ?? 0,
        input.approvalRequired ?? false,
        input.error ?? null,
        input.errorCode ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    const createdAt = result.rows[0]?.created_at as string;
    return { ...input, createdAt };
  }

  async listSpansByTraceId(traceId: string): Promise<SpanRecord[]> {
    const result = await this.pool.query(
      `SELECT id, trace_id, parent_span_id, run_id, kind, summary,
              start_ms, end_ms, duration_ms,
              token_input, token_output,
              tool_calls_count, tool_failures, model_calls_count,
              retry_count, approval_required,
              error, error_code, metadata, created_at
       FROM agent_trace_spans WHERE trace_id = $1
       ORDER BY start_ms ASC`,
      [traceId],
    );
    return result.rows.map(rowToSpan);
  }

  async listSpansByRunId(runId: string): Promise<SpanRecord[]> {
    const result = await this.pool.query(
      `SELECT id, trace_id, parent_span_id, run_id, kind, summary,
              start_ms, end_ms, duration_ms,
              token_input, token_output,
              tool_calls_count, tool_failures, model_calls_count,
              retry_count, approval_required,
              error, error_code, metadata, created_at
       FROM agent_trace_spans WHERE run_id = $1
       ORDER BY start_ms ASC`,
      [runId],
    );
    return result.rows.map(rowToSpan);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function rowToTrace(row: Record<string, unknown>): TraceRecord {
  return {
    id: row["id"] as string,
    runId: row["run_id"] as string,
    conversationId: (row["conversation_id"] as string) ?? undefined,
    startedAt: row["started_at"] as string,
    endedAt: (row["ended_at"] as string) ?? undefined,
    totalDurationMs: (row["total_duration_ms"] as number) ?? 0,
    totalTokenInput: (row["total_token_input"] as number) ?? 0,
    totalTokenOutput: (row["total_token_output"] as number) ?? 0,
    totalToolCalls: (row["total_tool_calls"] as number) ?? 0,
    totalToolFailures: (row["total_tool_failures"] as number) ?? 0,
    totalModelCalls: (row["total_model_calls"] as number) ?? 0,
    totalErrors: (row["total_errors"] as number) ?? 0,
    spanCount: (row["span_count"] as number) ?? 0,
    createdAt: row["created_at"] as string,
  };
}

function rowToSpan(row: Record<string, unknown>): SpanRecord {
  return {
    id: row["id"] as string,
    traceId: row["trace_id"] as string,
    parentSpanId: (row["parent_span_id"] as string) ?? undefined,
    runId: row["run_id"] as string,
    kind: row["kind"] as string,
    summary: (row["summary"] as string) ?? undefined,
    startMs: row["start_ms"] as bigint ? Number(row["start_ms"]) : (row["start_ms"] as number),
    endMs: row["end_ms"] as number ?? undefined,
    durationMs: (row["duration_ms"] as number) ?? undefined,
    tokenInput: (row["token_input"] as number) ?? 0,
    tokenOutput: (row["token_output"] as number) ?? 0,
    toolCallsCount: (row["tool_calls_count"] as number) ?? 0,
    toolFailures: (row["tool_failures"] as number) ?? 0,
    modelCallsCount: (row["model_calls_count"] as number) ?? 0,
    retryCount: (row["retry_count"] as number) ?? 0,
    approvalRequired: Boolean(row["approval_required"]),
    error: (row["error"] as string) ?? undefined,
    errorCode: (row["error_code"] as string) ?? undefined,
    metadata: (row["metadata"] as Record<string, unknown>) ?? {},
    createdAt: row["created_at"] as string,
  };
}
