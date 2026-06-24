-- Migration 021: Memory quality scores and relations persistence
-- Adds quality_score column, quality_metadata JSONB, and a dedicated
-- memory_relations join table for graph-based traversal and deduplication.

ALTER TABLE memory_metadata
  ADD COLUMN IF NOT EXISTS quality_score DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS quality_metadata JSONB;

CREATE TABLE IF NOT EXISTS memory_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_memory_id TEXT NOT NULL REFERENCES memory_metadata(id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memory_metadata(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('supersedes', 'contradicts', 'resolvedBy', 'confirmedBy', 'sourceOfTruth')),
  established_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason TEXT,
  confidence DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_relations_unique ON memory_relations(source_memory_id, target_memory_id, relation);
CREATE INDEX IF NOT EXISTS idx_memory_relations_source ON memory_relations(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_target ON memory_relations(target_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_relations_type ON memory_relations(relation);
