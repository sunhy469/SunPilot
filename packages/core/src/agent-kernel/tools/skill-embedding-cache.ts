import type { EmbeddingService } from "../context/embedding-service.js";

/**
 * SkillEmbeddingCache — shared, pre-warmed embedding index for skill
 * semantic matching (§P1-2).
 *
 * Problem: IntentRouter and ToolRetriever both compute skill embeddings
 * independently per turn, causing duplicate embedding API calls. On cold
 * start or after skill registry changes, this adds 50-200ms per call.
 *
 * Solution: Pre-warm embeddings at startup, share across consumers, and
 * invalidate incrementally on skill registry changes. Both IntentRouter
 * and ToolRetriever read from this cache instead of calling the embedding
 * service directly.
 *
 * Cache key: `${skillId}::${name} — ${description} — category: ${category}`
 */
export class SkillEmbeddingCache {
  private cache = new Map<string, number[]>();
  private pending = new Map<string, Promise<number[] | undefined>>();
  // §4.4: Query embedding cache — IntentRouter computes the query
  // embedding during Layer 1 matching, and ToolRetriever needs the SAME
  // embedding for its Layer 4 semantic scoring. Without this cache, the
  // query gets re-embedded on every ToolRetriever.retrieve() call,
  // wasting one embedding API call per turn.
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
   * Store a query embedding so ToolRetriever can reuse it without
   * re-calling the embedding API. Called by IntentRouter after it
   * computes the query embedding during Layer 1 matching.
   */
  setQueryEmbedding(query: string, embedding: number[]): void {
    this.queryCache.set(query, embedding);
  }

  /**
   * Get a previously-stored query embedding, or undefined if not cached.
   * ToolRetriever calls this before computing its own embedding.
   */
  getQueryEmbedding(query: string): number[] | undefined {
    return this.queryCache.get(query);
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
