-- 007_agent_runtime_core: Agent runtime enhancements
-- Architecture doc §20 — adds missing fields to existing tables
-- and creates run_status_history for recovery/debugging.

-- Add agent-oriented fields to runs
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS goal TEXT,
  ADD COLUMN IF NOT EXISTS error JSONB,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Add sequence and conversation tracking to events
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS conversation_id TEXT,
  ADD COLUMN IF NOT EXISTS sequence BIGSERIAL;

-- Create run_status_history for debugging recovery
CREATE TABLE IF NOT EXISTS run_status_history (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  previous_status TEXT,
  next_status TEXT NOT NULL,
  reason TEXT,
  actor TEXT NOT NULL DEFAULT 'system',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_run_status_history_run
  ON run_status_history(run_id, created_at);

-- Add index for events by conversation
CREATE INDEX IF NOT EXISTS idx_events_conversation
  ON events(conversation_id, created_at);

-- Add index for events by run and sequence (for reconnection compensation)
CREATE INDEX IF NOT EXISTS idx_events_run_sequence
  ON events(run_id, sequence);
