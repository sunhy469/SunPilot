import {
  type ContextChunk,
  DEFAULT_TOKEN_BUDGET,
  MANDATORY_SOURCES,
  TRIM_ORDER,
  estimateTokens,
} from './context-types.js';

export interface BudgetResult {
  included: ContextChunk[];
  excluded: ContextChunk[];
  totalTokens: number;
  budgetUsed: number;
}

/**
 * TokenBudgeter — trims context chunks to fit within a token budget.
 * Uses the allocation and trimming strategy from architecture doc §11.4.
 */
export class TokenBudgeter {
  constructor(
    private readonly maxTokens: number = 128_000,
    private readonly reservedForOutput: number = 16_000,
  ) {}

  /** Apply budget to a list of chunks, returning included and excluded sets. */
  apply(chunks: ContextChunk[]): BudgetResult {
    const availableTokens = this.maxTokens - this.reservedForOutput;

    // §2.4: Pre-compression pass — compress low-priority conversation_history
    // chunks instead of dropping them entirely. This runs BEFORE budget
    // allocation so compressed chunks are more likely to fit.
    const compressedChunks = chunks.map((chunk) => {
      if (
        chunk.source === 'conversation_history' &&
        chunk.content.length > 300 &&
        chunk.tokenEstimate > 75
      ) {
        const compressed = compressHistoryMessage(chunk.content, 300);
        return {
          ...chunk,
          content: compressed,
          tokenEstimate: estimateTokens(compressed),
          metadata: { ...chunk.metadata, preCompressed: true },
        };
      }
      return chunk;
    });

    // Separate mandatory chunks
    const mandatory: ContextChunk[] = [];
    const optional: ContextChunk[] = [];

    for (const chunk of compressedChunks) {
      if (MANDATORY_SOURCES.has(chunk.source)) {
        mandatory.push(chunk);
      } else {
        optional.push(chunk);
      }
    }

    const mandatoryTokens = mandatory.reduce(
      (sum, c) => sum + c.tokenEstimate,
      0,
    );

    // If even mandatory chunks exceed budget, we have a problem — include
    // all mandatory anyway and log a warning.
    if (mandatoryTokens > availableTokens) {
      console.warn(
        `[TokenBudgeter] Mandatory chunks use ${mandatoryTokens} tokens, ` +
          `exceeding budget of ${availableTokens}.`,
      );
      return {
        included: mandatory,
        excluded: optional,
        totalTokens: mandatoryTokens,
        budgetUsed: mandatoryTokens,
      };
    }

    // Sort optional chunks by priority (lower = more important), then by
    // trim order (chunks from trimmable sources are deprioritized).
    const remainingBudget = availableTokens - mandatoryTokens;

    // Build trim order map (lower index = trimmed first)
    const trimPriority = new Map<ContextChunk['source'], number>();
    TRIM_ORDER.forEach((source, idx) => trimPriority.set(source, idx));

    const sorted = [...optional].sort((a, b) => {
      // First by trim source priority (higher number = keep longer)
      const trimA = trimPriority.get(a.source) ?? TRIM_ORDER.length;
      const trimB = trimPriority.get(b.source) ?? TRIM_ORDER.length;
      if (trimB !== trimA) return trimB - trimA;
      // Then by explicit priority
      return a.priority - b.priority;
    });

    const included: ContextChunk[] = [...mandatory];
    const excluded: ContextChunk[] = [];
    // remainingBudget already excludes mandatoryTokens — start at 0
    // to avoid double-deducting mandatory from the optional pool.
    let usedTokens = 0;

    for (const chunk of sorted) {
      if (usedTokens + chunk.tokenEstimate <= remainingBudget) {
        included.push(chunk);
        usedTokens += chunk.tokenEstimate;
      } else {
        excluded.push(chunk);
      }
    }

    const totalTokens = mandatoryTokens + usedTokens;
    return {
      included,
      excluded,
      totalTokens,
      budgetUsed: totalTokens,
    };
  }

  /** Estimate total tokens for a collection of chunks. */
  static totalTokens(chunks: ContextChunk[]): number {
    return chunks.reduce((sum, c) => sum + c.tokenEstimate, 0);
  }

  /** Estimate tokens for a string. */
  static estimateTokens(text: string): number {
    return estimateTokens(text);
  }
}

/**
 * §2.4: Compress a history message to fit within maxChars.
 * Keeps the first sentence + a truncated tail with an ellipsis.
 */
function compressHistoryMessage(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const slice = content.slice(0, maxChars);
  const lastStop = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?'),
    slice.lastIndexOf('\n'),
  );
  if (lastStop > maxChars * 0.5) {
    return slice.slice(0, lastStop + 1) + '…';
  }
  return slice + '…';
}
