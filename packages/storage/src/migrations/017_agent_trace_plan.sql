-- 017_agent_trace_plan: Trace persistence and plan snapshot storage
-- Required by: P0-2 trace/plan/evidence persistence
-- Architecture doc: agent_architecture_next_steps.md §P0-2

-- ── Trace table: one per agent run ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_traces (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  conversation_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  total_duration_ms INTEGER DEFAULT 0,
  total_token_input INTEGER DEFAULT 0,
  total_token_output INTEGER DEFAULT 0,
  total_tool_calls INTEGER DEFAULT 0,
  total_tool_failures INTEGER DEFAULT 0,
  total_model_calls INTEGER DEFAULT 0,
  total_errors INTEGER DEFAULT 0,
  span_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_traces_run ON agent_traces(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_traces_conversation ON agent_traces(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_traces_created ON agent_traces(created_at);

-- ── Trace span table: per-phase spans within a trace ────────────────────
CREATE TABLE IF NOT EXISTS agent_trace_spans (
  id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
  parent_span_id TEXT,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT,
  start_ms BIGINT NOT NULL,
  end_ms BIGINT,
  duration_ms INTEGER,
  token_input INTEGER DEFAULT 0,
  token_output INTEGER DEFAULT 0,
  tool_calls_count INTEGER DEFAULT 0,
  tool_failures INTEGER DEFAULT 0,
  model_calls_count INTEGER DEFAULT 0,
  retry_count INTEGER DEFAULT 0,
  approval_required BOOLEAN DEFAULT FALSE,
  error TEXT,
  error_code TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN agent_trace_spans.kind IS 'Phase kind: context_building|tool_retrieval|react_model_turn|tool_guard|tool_executing|observation_building|checkpoint_persistence|memory_writing|approval_handling';
COMMENT ON COLUMN agent_trace_spans.metadata IS 'model_call_ids, tool_call_ids, event_sequences, purpose';

CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_trace ON agent_trace_spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_run ON agent_trace_spans(run_id);
CREATE INDEX IF NOT EXISTS idx_agent_trace_spans_kind ON agent_trace_spans(run_id, kind);

-- ── Plan snapshots: persisted plan state at each revision ───────────────
CREATE TABLE IF NOT EXISTS plan_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  event_type TEXT NOT NULL,
  plan_json JSONB NOT NULL,
  diff_summary TEXT,
  trigger TEXT,
  added_steps INTEGER DEFAULT 0,
  removed_steps INTEGER DEFAULT 0,
  modified_steps INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON COLUMN plan_snapshots.event_type IS 'agent.plan.created | agent.plan.validated | agent.plan.revised';
COMMENT ON COLUMN plan_snapshots.trigger IS 'Replan trigger: tool_failed|goal_changed|approval_rejected|etc';

CREATE INDEX IF NOT EXISTS idx_plan_snapshots_run ON plan_snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_plan_snapshots_plan ON plan_snapshots(plan_id, version);

-- ── Run plan state: living plan with step evidence ──────────────────────
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS active_plan_json JSONB,
  ADD COLUMN IF NOT EXISTS plan_revision_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN runs.active_plan_json IS 'Current plan state with step status and completion evidence';
COMMENT ON COLUMN runs.plan_revision_count IS 'Number of times the plan was revised during this run';
