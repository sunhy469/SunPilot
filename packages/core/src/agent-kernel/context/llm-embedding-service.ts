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
 * Architecture doc §9.2.
 */
export class LlmEmbeddingService implements EmbeddingService {
  /** Default embedding dimension (OpenAI text-embedding-3-small). */
  private static readonly DIM = 1536;

  /** Vocabulary size for keyword fallback. */
  private static readonly VOCAB_SIZE = 1536;

  constructor(
    private readonly deps: {
      llm: LlmProvider;
      /** Optional real embedding provider. When absent, falls back to keyword hashing. */
      embeddingProvider?: EmbeddingProvider;
    },
  ) {}

  async embed(text: string): Promise<number[]> {
    // Tier 1: Real embedding provider
    if (this.deps.embeddingProvider) {
      try {
        return await this.deps.embeddingProvider.embed(text);
      } catch {
        // Provider failed — fall through to keyword fallback
      }
    }
    // Tier 2: Lexical keyword fallback (NOT semantic — lexical overlap only)
    return this.keywordEmbed(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Tier 1: Real embedding provider (batch)
    if (this.deps.embeddingProvider) {
      try {
        return await this.deps.embeddingProvider.embedBatch(texts);
      } catch {
        // Provider failed — fall through to individual fallback
      }
    }
    // Tier 2: Fall back per-text
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  /** Whether a real embedding provider is configured (vs. fallback only). */
  get hasRealProvider(): boolean {
    return Boolean(this.deps.embeddingProvider);
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
    const vec = new Array<number>(LlmEmbeddingService.DIM).fill(0);
    const tokens = this.tokenize(text);
    if (tokens.length === 0) return vec;

    for (const token of tokens) {
      const idx = this.hashToken(token) % LlmEmbeddingService.DIM;
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
