/**
 * Run Debug Panel — minimal trace/plan/tool viewer for agent runs (§P3-11).
 *
 * Fetches /v1/runs/:id/trace and renders:
 * - Run status timeline
 * - Plan steps and revisions
 * - Tool call list with metadata
 * - Model call cost/latency
 * - Safety warnings (injection, sandbox, scope)
 * - Trace spans
 */

import { useState, useEffect, useCallback } from "react";

// ── Types ─────────────────────────────────────────────────────────────────

interface TraceResponse {
  runId: string;
  conversationId?: string;
  status: string;
  mode: string;
  activePlan: Record<string, unknown> | null;
  planRevisionCount: number;
  trace: {
    traceId: string;
    totalDurationMs: number;
    totalTokenInput: number;
    totalTokenOutput: number;
    totalToolCalls: number;
    totalToolFailures: number;
    totalModelCalls: number;
    totalErrors: number;
    spanCount: number;
  } | null;
  spans: Array<{
    id: string;
    kind: string;
    summary: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    tokenInput: number;
    tokenOutput: number;
    toolCallsCount: number;
    toolFailures: number;
    modelCallsCount: number;
    error?: string;
  }>;
  planSnapshots: Array<{
    id: string;
    version: number;
    eventType: string;
    diffSummary?: string;
    trigger?: string;
    addedSteps: number;
    removedSteps: number;
    modifiedSteps: number;
    createdAt: string;
  }>;
  timeline: {
    statusHistory: Array<{
      from: string;
      to: string;
      reason?: string;
      at: string;
    }>;
    events: Array<{
      type: string;
      sequence: number;
      at: string;
    }>;
  };
  modelCalls: Array<{
    id: string;
    provider: string;
    model: string;
    purpose: string;
    status: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    error?: unknown;
  }>;
  toolCalls: Array<{
    id: string;
    skillId: string;
    name: string;
    status: string;
    riskLevel: string;
    metadata?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string;
  }>;
  approvals: Array<{
    id: string;
    title: string;
    status: string;
    risk: string;
  }>;
}

// ── Component ─────────────────────────────────────────────────────────────

interface RunDebugPanelProps {
  runId: string;
  baseUrl?: string;
}

export function RunDebugPanel({ runId, baseUrl = "" }: RunDebugPanelProps) {
  const [data, setData] = useState<TraceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "spans" | "tools" | "models" | "plan">("overview");

  const fetchTrace = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${baseUrl}/v1/runs/${runId}/trace`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as TraceResponse;
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trace");
    } finally {
      setLoading(false);
    }
  }, [runId, baseUrl]);

  useEffect(() => {
    fetchTrace();
  }, [fetchTrace]);

  if (loading) return <div className="run-debug-panel loading">Loading trace…</div>;
  if (error) return <div className="run-debug-panel error">Error: {error}</div>;
  if (!data) return <div className="run-debug-panel empty">No trace data</div>;

  const safetyEvents = data.timeline.events.filter((e) =>
    e.type.startsWith("agent.safety."),
  );

  return (
    <div className="run-debug-panel">
      {/* Header */}
      <div className="run-debug-header">
        <h3>Run Debug: {runId.slice(0, 12)}…</h3>
        <span className={`status-badge status-${data.status}`}>{data.status}</span>
        <button onClick={fetchTrace} className="btn-refresh">↻</button>
      </div>

      {/* Overview stats */}
      {data.trace && (
        <div className="trace-stats">
          <Stat label="Duration" value={`${data.trace.totalDurationMs}ms`} />
          <Stat label="Tokens" value={`${data.trace.totalTokenInput}→${data.trace.totalTokenOutput}`} />
          <Stat label="Tool Calls" value={`${data.trace.totalToolCalls} (${data.trace.totalToolFailures} failed)`} />
          <Stat label="Model Calls" value={`${data.trace.totalModelCalls}`} />
          <Stat label="Errors" value={`${data.trace.totalErrors}`} />
          <Stat label="Spans" value={`${data.trace.spanCount}`} />
        </div>
      )}

      {/* Safety warnings */}
      {safetyEvents.length > 0 && (
        <div className="safety-warnings">
          <h4>⚠ Safety Events ({safetyEvents.length})</h4>
          <ul>
            {safetyEvents.map((e, i) => (
              <li key={i} className="safety-warning-item">
                [{e.sequence}] {e.type} — {e.at}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Tabs */}
      <div className="debug-tabs">
        {(["overview", "spans", "tools", "models", "plan"] as const).map((tab) => (
          <button
            key={tab}
            className={`tab-btn ${activeTab === tab ? "active" : ""}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="debug-tab-content">
        {activeTab === "overview" && (
          <div className="tab-overview">
            <h4>Status Timeline</h4>
            <ul>
              {data.timeline.statusHistory.map((h, i) => (
                <li key={i}>
                  {h.from} → {h.to}
                  {h.reason && ` (${h.reason})`}
                  <small> {new Date(h.at).toLocaleTimeString()}</small>
                </li>
              ))}
            </ul>

            <h4>Approvals</h4>
            {data.approvals.length === 0 ? (
              <p>No approvals</p>
            ) : (
              <ul>
                {data.approvals.map((a) => (
                  <li key={a.id}>
                    {a.title} — {a.status} ({a.risk})
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {activeTab === "spans" && (
          <div className="tab-spans">
            {data.spans.map((s) => (
              <div key={s.id} className={`span-row span-${s.kind}${s.error ? " has-error" : ""}`}>
                <div className="span-header">
                  <span className="span-kind">{s.kind}</span>
                  <span className="span-duration">{s.durationMs}ms</span>
                </div>
                <div className="span-summary">{s.summary}</div>
                <div className="span-metrics">
                  tokens: {s.tokenInput}→{s.tokenOutput} |
                  tools: {s.toolCallsCount}/{s.toolFailures} failures |
                  models: {s.modelCallsCount}
                </div>
                {s.error && <div className="span-error">{s.error}</div>}
              </div>
            ))}
          </div>
        )}

        {activeTab === "tools" && (
          <div className="tab-tools">
            {data.toolCalls.map((tc) => (
              <div key={tc.id} className={`tool-row tool-${tc.status}`}>
                <div className="tool-header">
                  <span className="tool-name">{tc.name}</span>
                  <span className={`tool-status status-${tc.status}`}>{tc.status}</span>
                  <span className={`tool-risk risk-${tc.riskLevel}`}>{tc.riskLevel}</span>
                </div>
                <div className="tool-id">{tc.skillId}</div>
                {tc.metadata && (
                  <div className="tool-metadata">
                    {tc.metadata.decisionPath && (
                      <span>decision: {String(tc.metadata.decisionPath)}</span>
                    )}
                    {tc.metadata.planStepId && (
                      <span> | step: {String(tc.metadata.planStepId).slice(0, 12)}</span>
                    )}
                    {tc.metadata.safety && (
                      <span className="safety-flag">
                        | ⚠ safety: {JSON.stringify(tc.metadata.safety)}
                      </span>
                    )}
                  </div>
                )}
                {tc.startedAt && <small>started: {tc.startedAt}</small>}
                {tc.completedAt && <small> | completed: {tc.completedAt}</small>}
              </div>
            ))}
          </div>
        )}

        {activeTab === "models" && (
          <div className="tab-models">
            {data.modelCalls.map((mc) => (
              <div key={mc.id} className={`model-row model-${mc.status}`}>
                <div className="model-header">
                  <span className="model-purpose">{mc.purpose}</span>
                  <span className="model-name">{mc.provider}/{mc.model}</span>
                  <span className={`model-status status-${mc.status}`}>{mc.status}</span>
                </div>
                <div className="model-metrics">
                  tokens: {mc.inputTokens}→{mc.outputTokens} |
                  latency: {mc.latencyMs}ms
                </div>
                {mc.error && <div className="model-error">{String(mc.error)}</div>}
              </div>
            ))}
          </div>
        )}

        {activeTab === "plan" && (
          <div className="tab-plan">
            <h4>Plan Revisions ({data.planRevisionCount})</h4>
            {data.planSnapshots.map((ps) => (
              <div key={ps.id} className="plan-snapshot">
                <div className="plan-header">
                  v{ps.version} — {ps.eventType}
                  {ps.trigger && <span className="plan-trigger"> ({ps.trigger})</span>}
                </div>
                {ps.diffSummary && <div className="plan-diff">{ps.diffSummary}</div>}
                <div className="plan-changes">
                  +{ps.addedSteps} added / -{ps.removedSteps} removed / ~{ps.modifiedSteps} modified
                </div>
                <small>{ps.createdAt}</small>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
