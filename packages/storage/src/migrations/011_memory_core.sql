ALTER TABLE memory_metadata
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'run',
  ADD COLUMN IF NOT EXISTS scope_id TEXT,
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'manual_note',
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS content TEXT,
  ADD COLUMN IF NOT EXISTS summary TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'runtime',
  ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  ADD COLUMN IF NOT EXISTS importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS superseded_by TEXT,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

UPDATE memory_metadata
SET
  scope = CASE WHEN run_id IS NOT NULL THEN 'run' ELSE scope END,
  scope_id = COALESCE(scope_id, run_id),
  title = COALESCE(title, key),
  content = COALESCE(content, CASE
    WHEN jsonb_typeof(value) = 'string' THEN trim(both '"' from value::text)
    ELSE value::text
  END),
  summary = COALESCE(summary, CASE
    WHEN jsonb_typeof(value) = 'string' THEN trim(both '"' from value::text)
    ELSE value::text
  END),
  updated_at = COALESCE(updated_at, created_at)
WHERE title IS NULL OR content IS NULL OR summary IS NULL OR scope_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_metadata_scope ON memory_metadata(scope, scope_id);
CREATE INDEX IF NOT EXISTS idx_memory_metadata_type ON memory_metadata(type);
CREATE INDEX IF NOT EXISTS idx_memory_metadata_deleted ON memory_metadata(deleted_at);
CREATE INDEX IF NOT EXISTS idx_memory_metadata_updated_at ON memory_metadata(updated_at);
