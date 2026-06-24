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
    const cached = this.cache.get(text);
    if (cached) {
      this._cacheStats.hits++;
      return cached;
    }
    this._cacheStats.misses++;

    // Tier 1: Real embedding provider
    if (this.deps.embeddingProvider && !this._degraded) {
      try {
        const vector = await this.deps.embeddingProvider.embed(text);
        this.cache.set(text, vector);
        return vector;
      } catch {
        // Provider failed — mark degraded so callers know similarity
        // scores from this point forward are lexical, not semantic.
        this._degraded = true;
        console.warn(
          "[embedding] Provider API call failed, switching to lexical fallback for remaining session. " +
          "Semantic short-circuit (IntentRouter Layer 1) is now disabled.",
        );
      }
    }
    // Tier 2: Lexical keyword fallback (NOT semantic — lexical overlap only)
    const fallbackVector = this.keywordEmbed(text);
    this.cache.set(text, fallbackVector);
    return fallbackVector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Check cache for all texts first
    const results: (number[] | null)[] = texts.map((t) => this.cache.get(t) ?? null);

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
      if (this.deps.embeddingProvider) {
        try {
          const vectors = await this.deps.embeddingProvider.embedBatch(uncachedTexts);
          for (let j = 0; j < uncachedIndices.length; j++) {
            const idx = uncachedIndices[j]!;
            const vector = vectors[j];
            if (vector && vector.length > 0) {
              this.cache.set(uncachedTexts[j]!, vector);
              results[idx] = vector;
            }
          }
        } catch {
          // Provider failed — fall through to per-text fallback
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

    if (this.deps.embeddingProvider) {
      try {
        const vectors = await this.deps.embeddingProvider.embedBatch(uncached);
        for (let i = 0; i < uncached.length; i++) {
          const text = uncached[i];
          const vector = vectors[i];
          if (text !== undefined && vector && vector.length > 0) {
            this.cache.set(text, vector);
          }
        }
      } catch {
        // Batch failed — fall back to individual (they'll cache on demand)
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
