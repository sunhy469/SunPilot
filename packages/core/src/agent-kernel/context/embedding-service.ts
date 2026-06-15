/**
 * EmbeddingService — text-to-vector embedding provider.
 *
 * Abstracts the embedding model behind a simple interface so
 * ContextBuilder and MemoryWriter can generate semantic embeddings
 * without coupling to a specific provider (OpenAI, local model, etc.).
 *
 * Architecture doc §9.2.
 */

export interface EmbeddingService {
  /** Generate an embedding vector for a single text. */
  embed(text: string): Promise<number[]>;

  /** Generate embeddings for a batch of texts (more efficient). */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * Hybrid retrieval score formula (architecture doc §9.3):
 *
 *   score = semanticSimilarity * 0.45
 *         + keywordRelevance   * 0.20
 *         + importance         * 0.15
 *         + recency            * 0.10
 *         + scopeBoost         * 0.10
 */
export const HYBRID_RETRIEVAL_WEIGHTS = {
  semanticSimilarity: 0.45,
  keywordRelevance: 0.2,
  importance: 0.15,
  recency: 0.1,
  scopeBoost: 0.1,
} as const;

/**
 * Calculate a hybrid retrieval score for a single result.
 */
export function calculateHybridScore(params: {
  semanticSimilarity: number;
  keywordRelevance: number;
  importance: number;
  recency: number;
  scopeBoost: number;
}): number {
  return (
    params.semanticSimilarity * HYBRID_RETRIEVAL_WEIGHTS.semanticSimilarity +
    params.keywordRelevance * HYBRID_RETRIEVAL_WEIGHTS.keywordRelevance +
    params.importance * HYBRID_RETRIEVAL_WEIGHTS.importance +
    params.recency * HYBRID_RETRIEVAL_WEIGHTS.recency +
    params.scopeBoost * HYBRID_RETRIEVAL_WEIGHTS.scopeBoost
  );
}

/**
 * Deduplicate retrieval results by id, keeping the highest-scoring entry.
 * Records retrieval sources for auditing (e.g. ["keyword", "semantic"]).
 */
export function deduplicateResults<T extends { id: string; score?: number }>(
  results: T[],
  source?: string,
): Array<T & { retrievalSources: string[] }> {
  const seen = new Map<string, { item: T; score: number; sources: Set<string> }>();

  for (const item of results) {
    const existing = seen.get(item.id);
    const itemScore = item.score ?? 0;
    if (!existing || itemScore > existing.score) {
      seen.set(item.id, {
        item,
        score: itemScore,
        sources: new Set(source ? [source] : []),
      });
    } else if (existing && source) {
      existing.sources.add(source);
    }
  }

  return Array.from(seen.values()).map((entry) => ({
    ...entry.item,
    retrievalSources: Array.from(entry.sources),
  }));
}
