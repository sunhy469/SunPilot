import type { EmbeddingService } from "../context/embedding-service.js";

/**
 * SkillEmbeddingCache — shared, pre-warmed embedding index for skill
 * semantic matching (§P1-2).
 *
 * Pre-warm embeddings at startup and invalidate incrementally on skill
 * registry changes so capability retrieval avoids duplicate API calls.
 *
 * Cache key: `${skillId}::${name} — ${description} — category: ${category}`
 */
export class SkillEmbeddingCache {
  private cache = new Map<string, number[]>();
  private pending = new Map<string, Promise<number[] | undefined>>();
  // Query embedding cache avoids re-embedding repeated catalog queries.
  /** §B7: Maximum query cache entries before LRU eviction kicks in. */
  private static readonly QUERY_CACHE_MAX_SIZE = 100;
  private queryCache = new Map<string, number[]>();

  constructor(private readonly embeddingService: EmbeddingService) {}

  /**
   * Get the embedding for a skill. Returns cached value if available,
   * otherwise computes and caches it. Deduplicates concurrent requests
   * for the same key via the pending map.
   */
  async getEmbedding(skill: {
    id: string;
    name: string;
    description: string;
    category: string;
  }): Promise<number[] | undefined> {
    const key = this.buildKey(skill);

    // Fast path: cache hit
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Dedup: reuse in-flight request for same key
    const pending = this.pending.get(key);
    if (pending) return pending;

    // Compute and cache
    const promise = this.embeddingService
      .embed(key)
      .then((embedding) => {
        this.cache.set(key, embedding);
        this.pending.delete(key);
        return embedding;
      })
      .catch(() => {
        this.pending.delete(key);
        return undefined;
      });

    this.pending.set(key, promise);
    return promise;
  }

  /**
   * Pre-warm the cache for all provided skills. Call at startup and
   * after skill registry changes. Runs in batches with a concurrency
   * limit to avoid overwhelming the embedding service.
   */
  async preWarm(
    skills: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
    }>,
    concurrency = 8,
  ): Promise<void> {
    // Filter out already-cached skills
    const uncached = skills.filter(
      (s) => !this.cache.has(this.buildKey(s)),
    );
    if (uncached.length === 0) return;

    // Batch process with concurrency limit
    for (let i = 0; i < uncached.length; i += concurrency) {
      const batch = uncached.slice(i, i + concurrency);
      await Promise.allSettled(
        batch.map((skill) => this.getEmbedding(skill)),
      );
    }
  }

  /**
   * Invalidate cache entries for skills whose descriptions may have
   * changed (e.g., after skill registry reload).
   */
  invalidate(skillIds?: string[]): void {
    if (!skillIds || skillIds.length === 0) {
      // Full invalidation
      this.cache.clear();
      this.pending.clear();
      return;
    }
    // Selective invalidation by skill ID prefix match
    const prefixSet = new Set(skillIds);
    for (const key of this.cache.keys()) {
      const prefix = key.split("::")[0];
      if (prefix && prefixSet.has(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /** Number of cached embeddings. */
  get size(): number {
    return this.cache.size;
  }

  // ── §4.4: Query embedding cache ──────────────────────────────────

  /**
   * Store a query embedding so catalog retrieval can reuse it without
   * re-calling the embedding API.
   */
  setQueryEmbedding(query: string, embedding: number[]): void {
    // LRU eviction: when at capacity and this is a new key, remove oldest entry.
    if (
      this.queryCache.size >= SkillEmbeddingCache.QUERY_CACHE_MAX_SIZE &&
      !this.queryCache.has(query)
    ) {
      const oldestKey = this.queryCache.keys().next().value;
      if (oldestKey !== undefined) this.queryCache.delete(oldestKey);
    }
    this.queryCache.set(query, embedding);
  }

  /**
   * Get a previously-stored query embedding, or undefined if not cached.
   * Catalog retrieval calls this before computing a new embedding.
   */
  getQueryEmbedding(query: string): number[] | undefined {
    const value = this.queryCache.get(query);
    if (value === undefined) return undefined;
    // Move to end (most recently used) by deleting + re-inserting.
    this.queryCache.delete(query);
    this.queryCache.set(query, value);
    return value;
  }

  /** Clear the query embedding cache (e.g., between unrelated runs). */
  clearQueryEmbeddings(): void {
    this.queryCache.clear();
  }

  private buildKey(skill: {
    id: string;
    name: string;
    description: string;
    category: string;
  }): string {
    return `${skill.id}::${skill.name} — ${skill.description} — category: ${skill.category}`;
  }
}
