-- 014_pgvector_embeddings: Semantic search infrastructure
-- Adds pgvector extension and embedding columns for memory and messages.

-- Enable pgvector extension (requires superuser or CREATE EXTENSION privilege)
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to memory_metadata for semantic memory retrieval
ALTER TABLE memory_metadata
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index for fast approximate nearest-neighbor search on memories
CREATE INDEX IF NOT EXISTS idx_memory_embedding
  ON memory_metadata USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200)
  WHERE embedding IS NOT NULL;

-- Add embedding column to messages for semantic message search
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index for fast approximate nearest-neighbor search on messages
CREATE INDEX IF NOT EXISTS idx_messages_embedding
  ON messages USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200)
  WHERE embedding IS NOT NULL;

-- Add embedding column to conversation_summaries table (future use)
-- This column is reserved for when a dedicated conversation_summaries table is created.
-- For now, summaries are stored in memory_metadata with type='conversation_summary'.
