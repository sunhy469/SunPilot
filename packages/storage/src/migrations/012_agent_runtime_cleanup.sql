-- 012_agent_runtime_cleanup: remove legacy workflow runtime semantics
-- Converts any remaining workflow-mode runs to agent mode,
-- cleans up legacy status values, and drops legacy columns.

-- Convert any remaining workflow-mode runs to agent mode
UPDATE runs
SET mode = 'agent'
WHERE mode = 'workflow';

-- Replace legacy status values with agent equivalents
UPDATE runs
SET status = 'interrupted'
WHERE status IN ('queued', 'running', 'paused');

-- Drop legacy workflow_id column if it exists
ALTER TABLE runs
  DROP COLUMN IF EXISTS workflow_id;

-- Add composite index for conversation-scoped run queries
CREATE INDEX IF NOT EXISTS idx_runs_conversation_updated
  ON runs(conversation_id, updated_at DESC, id DESC);
