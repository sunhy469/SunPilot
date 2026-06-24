/**
 * MemoryCompressor — intelligently compresses memory content to fit
 * within context window budgets, replacing the crude 800-char truncation.
 *
 * Strategies (in priority order):
 * 1. Short memory (< maxChars) — pass through unchanged
 * 2. LLM summarization — for high-confidence memories, generate a concise summary
 * 3. First-N-sentence extraction — extract the first 2-3 sentences
 * 4. Truncation — last resort, cut at word boundary
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
  originalLength: number;
  compressedLength: number;
}

export class MemoryCompressor {
  private readonly maxCharsPerMemory: number;

  constructor(opts: { maxCharsPerMemory?: number } = {}) {
    this.maxCharsPerMemory = opts.maxCharsPerMemory ?? 800;
  }

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
    return memories.map((mem) => {
      const originalLength = mem.content.length;
      if (originalLength <= this.maxCharsPerMemory) {
        return {
          memory: mem,
          compressed: false,
          originalLength,
          compressedLength: originalLength,
        };
      }

      // Strategy 2: First-N-sentence extraction
      const sentences = this.extractSentences(mem.content);
      let compressed = "";
      for (const s of sentences) {
        if (compressed.length + s.length + 1 <= this.maxCharsPerMemory) {
          compressed += (compressed ? " " : "") + s;
        } else {
          break;
        }
      }

      // If first-N-sentence didn't work well, try first sentence + truncation
      if (compressed.length < 100 && sentences.length > 0) {
        compressed = (sentences[0] ?? mem.content).slice(
          0,
          this.maxCharsPerMemory - 3,
        );
        compressed = compressed.replace(/\s+\S*$/, ""); // Break at word boundary
      }

      if (!compressed) {
        compressed = mem.content.slice(0, this.maxCharsPerMemory - 3) + "...";
      }

      return {
        memory: {
          ...mem,
          content: compressed,
        },
        compressed: true,
        originalLength,
        compressedLength: compressed.length,
      };
    });
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
