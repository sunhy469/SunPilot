import type { LlmProvider } from "../../llm/llm.provider.js";
import type { EmbeddingService } from "./embedding-service.js";

/**
 * A real embedding provider — wraps an external embedding API (OpenAI, etc.).
 * Implementations handle the HTTP call and return a float32 vector.
 */
export interface EmbeddingProvider {
  /** Generate an embedding vector for the given text. */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for a batch of texts. */
  embedBatch(texts: string[]): Promise<number[][]>;
}

/**
 * LlmEmbeddingService — generates text embeddings using a real embedding
 * provider when configured, falling back to keyword-frequency vectors
 * when no dedicated embedding API is available.
 *
 * Two-tier strategy:
 *   1. REAL: Use the configured EmbeddingProvider (e.g. OpenAI text-embedding-3-small)
 *   2. FALLBACK: Lexical keyword-hashing — provides basic keyword-overlap
 *      signal for pgvector scoring but is NOT semantic. This is explicitly
 *      documented so callers understand the degradation.
 *
 * Caching:
 *   Embeddings are cached by text content hash. Cache keys are the full
 *   text string, so "skill.name — skill.description" and standalone
 *   "skill.description" are separate entries. This avoids re-embedding
 *   the same skill on every request. The cache is cleared when
 *   invalidateCache() is called (e.g. on skill registry reload).
 *
 * Architecture doc §9.2.
 */
export class LlmEmbeddingService implements EmbeddingService {
  /** Default embedding dimension (OpenAI text-embedding-3-small). */
  private static readonly DEFAULT_DIM = 1536;

  /** §B7: Maximum cache entries before LRU eviction kicks in. */
  private static readonly MAX_CACHE_SIZE = 1000;

  /** Cache: text → embedding vector. Shared across all callers. */
  private readonly cache = new Map<string, number[]>();

  /** Cache statistics for trace/debug observability. */
  private _cacheStats = { hits: 0, misses: 0 };

  /**
   * Whether the service has fallen back to keyword/hash embeddings
   * due to a provider failure during this session. Once degraded,
   * similarity scores are NOT semantic and MUST NOT be used to
   * short-circuit LLM-based intent classification.
   */
  private _degraded = false;

  /** §B6: timestamp (ms) when the service entered degraded mode. */
  private _degradedAt = 0;

  /** §B6: how long to skip the real provider before retrying (5 minutes). */
  private static readonly DEGRADED_RECOVERY_MS = 5 * 60 * 1000;

  /** Configured embedding dimension. */
  readonly dimension: number;

  constructor(
    private readonly deps: {
      llm: LlmProvider;
      /** Optional real embedding provider. When absent, falls back to keyword hashing. */
      embeddingProvider?: EmbeddingProvider;
      /** Embedding dimension. Defaults to 1536 (OpenAI text-embedding-3-small). */
      dimension?: number;
    },
  ) {
    this.dimension = deps.dimension ?? LlmEmbeddingService.DEFAULT_DIM;
  }

  async embed(text: string): Promise<number[]> {
    // Check cache first
    const cached = this.cacheGet(text);
    if (cached) {
      this._cacheStats.hits++;
      return cached;
    }
    this._cacheStats.misses++;

    // Tier 1: Real embedding provider
    if (this.deps.embeddingProvider && this.shouldTryRealProvider()) {
      try {
        const vector = await this.deps.embeddingProvider.embed(text);
        // §B6: provider succeeded — clear degraded state so future calls
        // can use the real provider without waiting for the recovery window.
        if (this._degraded) {
          this._degraded = false;
          this._degradedAt = 0;
        }
        this.cacheSet(text, vector);
        return vector;
      } catch {
        // Provider failed — mark degraded so callers know similarity
        // scores from this point forward are lexical, not semantic.
        // §B6: record the timestamp so we can retry after the recovery
        // window instead of staying degraded forever.
        if (!this._degraded) {
          this._degraded = true;
          this._degradedAt = Date.now();
          console.warn(
            "[embedding] Provider API call failed, switching to lexical fallback. " +
            "Semantic short-circuit (IntentRouter Layer 1) is now disabled. " +
            `Will retry the real provider in ${LlmEmbeddingService.DEGRADED_RECOVERY_MS / 1000}s.`,
          );
        }
      }
    }
    // Tier 2: Lexical keyword fallback (NOT semantic — lexical overlap only)
    const fallbackVector = this.keywordEmbed(text);
    this.cacheSet(text, fallbackVector);
    return fallbackVector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Check cache for all texts first
    const results: (number[] | null)[] = texts.map((t) => this.cacheGet(t) ?? null);

    // Collect uncached texts
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i] === null) {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]!);
      } else {
        this._cacheStats.hits++;
      }
    }

    if (uncachedTexts.length > 0) {
      this._cacheStats.misses += uncachedTexts.length;

      // Tier 1: Real embedding provider (batch)
      if (this.deps.embeddingProvider && this.shouldTryRealProvider()) {
        try {
          const vectors = await this.deps.embeddingProvider.embedBatch(uncachedTexts);
          if (this._degraded) {
            this._degraded = false;
            this._degradedAt = 0;
          }
          for (let j = 0; j < uncachedIndices.length; j++) {
            const idx = uncachedIndices[j]!;
            const vector = vectors[j];
            if (vector && vector.length > 0) {
              this.cacheSet(uncachedTexts[j]!, vector);
              results[idx] = vector;
            }
          }
        } catch {
          // Provider failed — fall through to per-text fallback
          if (!this._degraded) {
            this._degraded = true;
            this._degradedAt = Date.now();
          }
        }
      }

      // Fill any remaining nulls via individual embed (which also caches)
      for (let j = 0; j < results.length; j++) {
        if (results[j] === null) {
          results[j] = await this.embed(texts[j]!);
        }
      }
    }

    return results as number[][];
  }

  /**
   * §B6: decide whether to attempt the real provider. Always try when not
   * degraded; when degraded, only retry after the recovery window has
   * elapsed so a transient outage doesn't permanently disable semantic
   * embeddings.
   */
  private shouldTryRealProvider(): boolean {
    if (!this._degraded) return true;
    return Date.now() - this._degradedAt >= LlmEmbeddingService.DEGRADED_RECOVERY_MS;
  }

  /**
   * §B7: LRU-aware cache get. Re-inserts the entry so it moves to the end
   * of the Map's insertion order (most recently used).
   */
  private cacheGet(key: string): number[] | undefined {
    const value = this.cache.get(key);
    if (value === undefined) return undefined;
    // Move to end (most recently used) by deleting + re-inserting.
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  /**
   * §B7: LRU-aware cache set. Evicts the oldest entry (first key in
   * insertion order) when the cache exceeds MAX_CACHE_SIZE.
   */
  private cacheSet(key: string, value: number[]): void {
    if (this.cache.size >= LlmEmbeddingService.MAX_CACHE_SIZE && !this.cache.has(key)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, value);
  }

  /**
   * Whether a real embedding provider is configured AND has not
   * degraded to fallback. Callers that short-circuit on semantic
   * similarity (e.g. IntentRouter Layer 1) MUST check this before
   * trusting cosine-similarity scores.
   */
  get hasRealProvider(): boolean {
    return Boolean(this.deps.embeddingProvider) && !this._degraded;
  }

  /**
   * Whether the service is currently using lexical fallback
   * (either because no provider was configured, or because the
   * provider failed at runtime).
   */
  get isDegraded(): boolean {
    return this._degraded || !this.deps.embeddingProvider;
  }

  /** Reset degraded state (e.g. after provider recovers or on config reload). */
  clearDegraded(): void {
    this._degraded = false;
    this._degradedAt = 0;
  }

  /** Read-only snapshot of cache statistics for trace/debug. */
  get cacheStats(): Readonly<{ hits: number; misses: number }> {
    return { ...this._cacheStats };
  }

  /** Total cached entries (for monitoring). */
  get cacheSize(): number {
    return this.cache.size;
  }

  /**
   * Pre-warm the embedding cache for a batch of texts.
   * Useful for pre-computing skill embeddings at startup or after
   * skill registry reload. Uses batch embed when a real provider
   * is available, otherwise falls back per-text.
   */
  async preWarm(texts: string[]): Promise<void> {
    // Filter out already-cached texts
    const uncached = texts.filter((t) => !this.cache.has(t));
    if (uncached.length === 0) return;

    if (this.deps.embeddingProvider && this.shouldTryRealProvider()) {
      try {
        const vectors = await this.deps.embeddingProvider.embedBatch(uncached);
        if (this._degraded) {
          this._degraded = false;
          this._degradedAt = 0;
        }
        for (let i = 0; i < uncached.length; i++) {
          const text = uncached[i];
          const vector = vectors[i];
          if (text !== undefined && vector && vector.length > 0) {
            this.cacheSet(text, vector);
          }
        }
      } catch {
        // Batch failed — fall back to individual (they'll cache on demand)
        if (!this._degraded) {
          this._degraded = true;
          this._degradedAt = Date.now();
        }
      }
    }
    // Fallback vectors are computed on demand and cached individually
  }

  /**
   * Clear the embedding cache. Call this when the skill registry
   * is reloaded so stale embeddings are not reused.
   */
  invalidateCache(): void {
    this.cache.clear();
    this._cacheStats = { hits: 0, misses: 0 };
  }

  /**
   * Keyword-frequency embedding fallback.
   *
   * Tokenizes the input text into character bigrams and CJK segments,
   * hashes each token to a dimension index, and builds a sparse
   * normalized vector. This is NOT a semantic embedding — it provides
   * basic lexical overlap signals until a real embedding API is
   * configured.
   */
  private keywordEmbed(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const tokens = this.tokenize(text);
    if (tokens.length === 0) return vec;

    for (const token of tokens) {
      const idx = this.hashToken(token) % this.dimension;
      const current = vec[idx];
      if (current !== undefined) vec[idx] = current + 1;
    }

    // L2-normalize
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        const current = vec[i];
        if (current !== undefined) vec[i] = current / norm;
      }
    }

    return vec;
  }

  private tokenize(text: string): string[] {
    const tokens: string[] = [];
    const lower = text.toLowerCase();

    // CJK 2-char bigrams
    const cjk = /[一-鿿㐀-䶿]{2,}/g;
    let match: RegExpExecArray | null;
    while ((match = cjk.exec(lower)) !== null) {
      const seg = match[0];
      for (let i = 0; i < seg.length - 1; i++) {
        tokens.push(seg.slice(i, i + 2));
      }
    }

    // English/alphanumeric tokens (2+ chars)
    const alpha = /[a-z0-9]{2,}/g;
    while ((match = alpha.exec(lower)) !== null) {
      tokens.push(match[0]);
    }

    return tokens;
  }

  private hashToken(token: string): number {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      const ch = token.charCodeAt(i);
      hash = ((hash << 5) - hash + ch) | 0;
    }
    return Math.abs(hash);
  }
}
