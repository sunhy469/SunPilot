/**
 * A retrieved memory candidate with an embedding vector for similarity computation.
 */
export interface RerankerCandidate {
  id: string;
  score: number;
  title?: string;
  content?: string;
  embedding?: number[];
}

/**
 * MemoryReranker — re-ranks retrieved memory candidates to improve
 * relevance and diversity before injecting into the context.
 */
export interface MemoryReranker {
  rerank(
    query: string,
    candidates: RerankerCandidate[],
    topK: number,
  ): Promise<RerankerCandidate[]>;
}

/**
 * MmrMemoryReranker — implements Maximum Marginal Relevance (MMR)
 * to balance relevance with diversity.
 *
 * MMR formula:
 *   argmax_i [ λ * sim(query, d_i) - (1-λ) * max_j sim(d_i, d_j) ]
 *
 * Higher λ (default 0.7) favors relevance over diversity.
 * Lower λ favors diversity, reducing near-duplicate memories.
 */
export class MmrMemoryReranker implements MemoryReranker {
  private readonly lambda: number;

  constructor(
    deps: {
      lambda?: number;
    } = {},
  ) {
    this.lambda = deps.lambda ?? 0.7;
  }

  async rerank(
    _query: string,
    candidates: RerankerCandidate[],
    topK: number,
  ): Promise<RerankerCandidate[]> {
    if (candidates.length <= topK) return candidates;

    const selected: RerankerCandidate[] = [];
    const remaining = [...candidates];

    while (selected.length < topK && remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;

      for (let i = 0; i < remaining.length; i++) {
        const ci = remaining[i]!;
        // Relevance: use the existing score as the base relevance signal
        const relevance = ci.score;

        // Diversity: max similarity to any already-selected candidate
        let maxSim = 0;
        for (const sj of selected) {
          const sim = this.cosineSimilarity(ci.embedding, sj.embedding);
          if (sim > maxSim) maxSim = sim;
        }

        const mmr = this.lambda * relevance - (1 - this.lambda) * maxSim;
        if (mmr > bestScore) {
          bestScore = mmr;
          bestIdx = i;
        }
      }

      const chosen = remaining[bestIdx]!;
      selected.push(chosen);
      remaining.splice(bestIdx, 1);
    }

    return selected;
  }

  private cosineSimilarity(
    a: number[] | undefined,
    b: number[] | undefined,
  ): number {
    // §B4: dimension mismatch usually means comparing embeddings from
    // different models / providers — silently truncating would produce a
    // meaningless score. Fail closed (0) and log so the operator can fix the
    // configuration.
    if (!a || !b || a.length === 0) return 0;
    if (a.length !== b.length) {
      console.warn(
        `[memory-reranker] cosineSimilarity dimension mismatch: ${a.length} vs ${b.length}; returning 0`,
      );
      return 0;
    }
    let dot = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += (a[i] ?? 0) * (b[i] ?? 0);
      normA += (a[i] ?? 0) * (a[i] ?? 0);
      normB += (b[i] ?? 0) * (b[i] ?? 0);
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

/**
 * PairwiseMemoryReranker — lightweight re-ranking using pairwise
 * cross-comparison without requiring LLM calls.
 *
 * Each candidate's final score is:
 *   final = relevance * 0.6 + (1 - avgOverlapWithOthers) * 0.4
 *
 * This penalizes candidates that are too similar to others,
 * boosting unique results.
 */
export class PairwiseMemoryReranker implements MemoryReranker {
  async rerank(
    _query: string,
    candidates: RerankerCandidate[],
    topK: number,
  ): Promise<RerankerCandidate[]> {
    if (candidates.length <= topK) return candidates;

    const scored = candidates.map((c, i) => {
      let avgOverlap = 0;
      let comparisons = 0;
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        const sim = this.jaccardOverlap(c.content ?? "", candidates[j]?.content ?? "");
        avgOverlap += sim;
        comparisons++;
      }
      avgOverlap = comparisons > 0 ? avgOverlap / comparisons : 0;

      const finalScore = c.score * 0.6 + (1 - avgOverlap) * 0.4;
      return { ...c, score: finalScore };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  private jaccardOverlap(a: string, b: string): number {
    if (!a || !b) return 0;
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
    let intersection = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) intersection++;
    }
    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }
}
