-- 015_model_calls_metadata: Add metadata column for context snapshots
-- Architecture doc §11 — stores context chunk lists for debugging.

ALTER TABLE model_calls
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
