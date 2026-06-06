-- 008_agent_events_sequence: Event indexing and performance
-- Architecture doc §20.5, §21.4 — event sequence and type indexes.

-- Add an index on event type for filtering agent.* events
CREATE INDEX IF NOT EXISTS idx_events_type
  ON events(type);

-- Add composite index for event replay by run + sequence
-- This supports the reconnection protocol where the client
-- requests events with sequence > lastSeenSequence.
CREATE INDEX IF NOT EXISTS idx_events_run_type_seq
  ON events(run_id, type, sequence);

-- Add event type index for conversation-scoped queries
CREATE INDEX IF NOT EXISTS idx_events_conversation_type
  ON events(conversation_id, type, created_at);
