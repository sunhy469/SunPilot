CREATE TABLE IF NOT EXISTS agent_event_outbox (
  event_id TEXT PRIMARY KEY,
  event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS agent_event_outbox_created_idx
  ON agent_event_outbox (created_at ASC, event_id ASC);
