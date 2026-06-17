-- Add stale_reason and stale_since columns to memory_metadata
-- These support the mark-stale API and stale detection governance loop.
ALTER TABLE memory_metadata
  ADD COLUMN IF NOT EXISTS stale_reason TEXT,
  ADD COLUMN IF NOT EXISTS stale_since TIMESTAMPTZ;
