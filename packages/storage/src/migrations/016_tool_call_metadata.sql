-- 016_tool_call_metadata: Add metadata column for audit and repair history
-- Required by: repair loop audit, argument source persistence (P0-2)

ALTER TABLE IF EXISTS tool_calls
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN tool_calls.metadata IS 'Audit metadata: argument sources, repair history, input schema used';
