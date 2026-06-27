/**
 * MemoryCompressor — intelligently compresses memory content to fit
 * within context window budgets, replacing the crude 800-char truncation.
 *
 * Strategies (in priority order):
 * 1. Short memory (< maxChars) — pass through unchanged
 * 2. LLM summarization — for high-confidence memories, generate a concise summary
 *    (only when `summarize` callback is provided and content exceeds the
 *    summarization threshold)
 * 3. First-N-sentence extraction — extract the first 2-3 sentences
 * 4. Sentence + truncation — fallback when extraction yields < 100 chars
 * 5. Pure truncation — last resort, cut at word boundary with "..."
 */

export interface CompressedMemory {
  memory: {
    id: string;
    type: string;
    title: string;
    content: string;
    confidence: number;
    importance: number;
    createdAt: string;
  };
  compressed: boolean;
  /** Whether the content was summarized by an LLM (higher quality). */
  llmSummarized?: boolean;
  originalLength: number;
  compressedLength: number;
}

export interface MemoryCompressorDeps {
  maxCharsPerMemory?: number;
  /**
   * Optional LLM-based summarizer.
   *
   * Called when content exceeds the summarization threshold and a summary
   * callback is available. The callback receives the full content and the
   * target character budget; it should return a concise summary.
   *
   * When the callback throws or returns an empty/too-long result, the
   * compressor falls back to sentence-extraction strategies.
   */
  summarize?: (content: string, maxChars: number) => Promise<string>;
  /**
   * Minimum content length (in characters) before LLM summarization is
   * attempted. Default 400. Below this threshold, sentence extraction is
   * usually sufficient.
   */
  summarizeMinChars?: number;
}

export class MemoryCompressor {
  private readonly maxCharsPerMemory: number;
  private readonly summarize?: (content: string, maxChars: number) => Promise<string>;
  private readonly summarizeMinChars: number;

  constructor(opts: MemoryCompressorDeps = {}) {
    this.maxCharsPerMemory = opts.maxCharsPerMemory ?? 800;
    this.summarize = opts.summarize;
    this.summarizeMinChars = opts.summarizeMinChars ?? 400;
  }

  /**
   * Synchronous compression using sentence extraction and truncation only.
   * LLM summarization is not available in the sync path.
   */
  compress(
    memories: Array<{
      id: string;
      type: string;
      title: string;
      content: string;
      confidence: number;
      importance: number;
      createdAt: string;
    }>,
  ): CompressedMemory[] {
    return memories.map((mem) => this.compressOne(mem));
  }

  /**
   * Asynchronous compression that attempts LLM summarization when a
   * `summarize` callback is configured and the content exceeds the
   * summarization threshold.
   *
   * Falls back to sentence-extraction if LLM summarization fails or
   * returns content that still exceeds the budget.
   */
  async compressAsync(
    memories: Array<{
      id: string;
      type: string;
      title: string;
      content: string;
      confidence: number;
      importance: number;
      createdAt: string;
    }>,
    concurrency = 4,
  ): Promise<CompressedMemory[]> {
    const results: CompressedMemory[] = [];
    for (let i = 0; i < memories.length; i += concurrency) {
      const batch = memories.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map((mem) => this.compressOneAsync(mem)),
      );
      for (let j = 0; j < batchResults.length; j++) {
        const r = batchResults[j]!;
        if (r.status === "fulfilled") {
          results.push(r.value);
        } else {
          // Fall back to synchronous compression on failure
          const mem = batch[j]!;
          results.push(this.compressOne(mem));
        }
      }
    }
    return results;
  }

  /**
   * Compress a single memory (synchronous path).
   */
  private compressOne(mem: {
    id: string;
    type: string;
    title: string;
    content: string;
    confidence: number;
    importance: number;
    createdAt: string;
  }): CompressedMemory {
    const originalLength = mem.content.length;
    if (originalLength <= this.maxCharsPerMemory) {
      return {
        memory: mem,
        compressed: false,
        originalLength,
        compressedLength: originalLength,
      };
    }

    const compressed = this.extractAndTruncate(mem.content);
    return {
      memory: { ...mem, content: compressed },
      compressed: true,
      originalLength,
      compressedLength: compressed.length,
    };
  }

  /**
   * Compress a single memory with optional LLM summarization.
   */
  private async compressOneAsync(mem: {
    id: string;
    type: string;
    title: string;
    content: string;
    confidence: number;
    importance: number;
    createdAt: string;
  }): Promise<CompressedMemory> {
    const originalLength = mem.content.length;
    if (originalLength <= this.maxCharsPerMemory) {
      return {
        memory: mem,
        compressed: false,
        originalLength,
        compressedLength: originalLength,
      };
    }

    // Strategy 2: LLM summarization (when callback is provided and
    // content is long enough to justify the LLM call).
    if (this.summarize && originalLength >= this.summarizeMinChars) {
      try {
        const summary = await this.summarize(mem.content, this.maxCharsPerMemory);
        if (summary && summary.length > 0 && summary.length <= this.maxCharsPerMemory) {
          return {
            memory: { ...mem, content: summary },
            compressed: true,
            llmSummarized: true,
            originalLength,
            compressedLength: summary.length,
          };
        }
        // If summary is too long, try sentence extraction on the summary
        if (summary && summary.length > this.maxCharsPerMemory) {
          const trimmed = this.extractAndTruncate(summary);
          if (trimmed.length < originalLength) {
            return {
              memory: { ...mem, content: trimmed },
              compressed: true,
              llmSummarized: true,
              originalLength,
              compressedLength: trimmed.length,
            };
          }
        }
      } catch {
        // LLM summarization failed — fall through to sentence extraction
      }
    }

    // Strategy 3-5: fallback to sentence extraction and truncation
    const compressed = this.extractAndTruncate(mem.content);
    return {
      memory: { ...mem, content: compressed },
      compressed: true,
      originalLength,
      compressedLength: compressed.length,
    };
  }

  /**
   * Shared sentence-extraction and truncation logic (strategies 3-5).
   */
  private extractAndTruncate(content: string): string {
    // Strategy 3: First-N-sentence extraction
    const sentences = this.extractSentences(content);
    let compressed = "";
    for (const s of sentences) {
      if (compressed.length + s.length + 1 <= this.maxCharsPerMemory) {
        compressed += (compressed ? " " : "") + s;
      } else {
        break;
      }
    }

    // Strategy 4: If first-N-sentence didn't work well, try first sentence + truncation
    if (compressed.length < 100 && sentences.length > 0) {
      compressed = (sentences[0] ?? content).slice(
        0,
        this.maxCharsPerMemory - 3,
      );
      compressed = compressed.replace(/\s+\S*$/, ""); // Break at word boundary
    }

    // Strategy 5: Pure truncation as last resort
    if (!compressed) {
      compressed = content.slice(0, this.maxCharsPerMemory - 3) + "...";
    }

    return compressed;
  }

  /**
   * Split text into sentences using basic punctuation boundaries.
   */
  private extractSentences(text: string): string[] {
    // Split on sentence-ending punctuation followed by space or end-of-string
    const sentences = text
      .split(/(?<=[.!?。！？\n])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return sentences.length > 0 ? sentences : [text];
  }
}
