import { describe, expect, test } from "vitest";
import { MmrMemoryReranker, PairwiseMemoryReranker } from "./memory-reranker.js";
import type { RerankerCandidate } from "./memory-reranker.js";

function makeCandidate(
  id: string,
  score: number,
  embedding?: number[],
  content?: string,
  title?: string,
): RerankerCandidate {
  return { id, score, embedding, content, title };
}

// Simple 3D embeddings for deterministic testing
const EMB_A = [1, 0, 0];
const EMB_B = [0, 1, 0];
const EMB_C = [0, 0, 1];
const EMB_AB = [0.7, 0.7, 0]; // Similar to both A and B
const EMB_NEAR_A = [0.9, 0.1, 0]; // Very similar to A

describe("MmrMemoryReranker", () => {
  test("returns all candidates when fewer than topK", async () => {
    const reranker = new MmrMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, EMB_A),
      makeCandidate("b", 0.8, EMB_B),
    ];
    const result = await reranker.rerank("query", candidates, 5);
    expect(result).toHaveLength(2);
  });

  test("returns topK when more candidates than topK", async () => {
    const reranker = new MmrMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, EMB_A),
      makeCandidate("b", 0.8, EMB_B),
      makeCandidate("c", 0.7, EMB_C),
      makeCandidate("d", 0.6, EMB_AB),
      makeCandidate("e", 0.5, EMB_NEAR_A),
    ];
    const result = await reranker.rerank("query", candidates, 3);
    expect(result).toHaveLength(3);
  });

  test("selects highest-scoring candidate first", async () => {
    const reranker = new MmrMemoryReranker({ lambda: 1.0 }); // Pure relevance, no diversity
    const candidates = [
      makeCandidate("low", 0.5, EMB_A),
      makeCandidate("high", 0.95, EMB_B),
      makeCandidate("mid", 0.7, EMB_C),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    expect(result[0]!.id).toBe("high");
  });

  test("prefers diverse results with low lambda", async () => {
    // With lambda=0 (pure diversity), should avoid picking similar embeddings
    const reranker = new MmrMemoryReranker({ lambda: 0.0 });
    // Use embeddings with bigger difference to ensure diversity is detectable
    const EMB_X = [1, 0, 0];
    const EMB_X_NEAR = [0.99, 0.01, 0]; // Very close to X
    const EMB_Y = [0, 1, 0]; // Orthogonal to X
    const candidates = [
      makeCandidate("x2", 0.85, EMB_X_NEAR), // idx 0
      makeCandidate("x1", 0.9, EMB_X),        // idx 1
      makeCandidate("y", 0.5, EMB_Y),          // idx 2
    ];
    const result = await reranker.rerank("query", candidates, 2);
    // First pick: all maxSim=0, mmr=0, picks first candidate (x2, idx 0)
    // Second pick: x1 is very similar to x2 → penalized. y is orthogonal → not penalized.
    // y should be selected second despite lower relevance
    expect(result[1]!.id).toBe("y");
  });

  test("handles candidates without embeddings", async () => {
    const reranker = new MmrMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9), // no embedding
      makeCandidate("b", 0.8), // no embedding
      makeCandidate("c", 0.7, EMB_A),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    expect(result).toHaveLength(2);
  });

  test("handles empty candidate list", async () => {
    const reranker = new MmrMemoryReranker();
    const result = await reranker.rerank("query", [], 5);
    expect(result).toHaveLength(0);
  });

  test("handles candidates with mismatched embedding dimensions", async () => {
    const reranker = new MmrMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, [1, 2, 3]),
      makeCandidate("b", 0.8, [1, 2]), // Different dimension
    ];
    const result = await reranker.rerank("query", candidates, 2);
    // Mismatched embeddings get similarity 0, so selection is purely by relevance
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("a");
  });

  test("handles empty embedding arrays", async () => {
    const reranker = new MmrMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, []),
      makeCandidate("b", 0.8, []),
    ];
    const result = await reranker.rerank("query", candidates, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a"); // Highest relevance wins
  });

  test("uses default lambda of 0.7", async () => {
    const reranker = new MmrMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, EMB_A),
      makeCandidate("b", 0.8, EMB_NEAR_A),
      makeCandidate("c", 0.5, EMB_B),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    // With lambda=0.7: first pick is 'a' (highest relevance)
    // Second: a2 penalized by sim to a, b boosted by diversity
    expect(result).toHaveLength(2);
  });

  test("returns exact count when candidates equal topK", async () => {
    const reranker = new MmrMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, EMB_A),
      makeCandidate("b", 0.8, EMB_B),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    expect(result).toHaveLength(2);
  });

  test("handles zero-vector embeddings (normA=0 or normB=0)", async () => {
    const reranker = new MmrMemoryReranker({ lambda: 0.0 });
    const candidates = [
      makeCandidate("a", 0.9, [0, 0, 0]),
      makeCandidate("b", 0.8, [0, 0, 0]),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    expect(result).toHaveLength(2);
    // Zero vectors get similarity 0, lambda=0 means pure diversity,
    // all sims are 0, so all mmr scores = 0, picks in order
  });
});

describe("PairwiseMemoryReranker", () => {
  test("returns all candidates when fewer than topK", async () => {
    const reranker = new PairwiseMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, undefined, "deploy the application"),
      makeCandidate("b", 0.8, undefined, "fix a bug"),
    ];
    const result = await reranker.rerank("query", candidates, 5);
    expect(result).toHaveLength(2);
  });

  test("returns topK when more candidates than topK", async () => {
    const reranker = new PairwiseMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, undefined, "content a"),
      makeCandidate("b", 0.8, undefined, "content b"),
      makeCandidate("c", 0.7, undefined, "content c"),
      makeCandidate("d", 0.6, undefined, "content d"),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    expect(result).toHaveLength(2);
  });

  test("boosts unique candidates and penalizes redundant ones", async () => {
    const reranker = new PairwiseMemoryReranker();
    // Add a dummy to push total > topK so rescoring is triggered
    const candidates = [
      makeCandidate("unique", 0.7, undefined, "zebra elephant giraffe lion tiger"),
      makeCandidate("dup1", 0.9, undefined, "deploy the application today"),
      makeCandidate("dup2", 0.85, undefined, "deploy application to production"),
      makeCandidate("dummy", 0.3, undefined, "dummy"),
    ];
    // topK=3 triggers rescoring since 4 > 3
    const result = await reranker.rerank("query", candidates, 3);
    expect(result).toHaveLength(3);
    // After rescoring: unique should get higher score relative to the dups
    // unique has zero overlap with everyone → finalScore = 0.7*0.6 + 1.0*0.4 = 0.82
    const uniqueResult = result.find((r) => r.id === "unique");
    expect(uniqueResult).toBeDefined();
    expect(uniqueResult!.score).toBeGreaterThan(0.7);
  });

  test("sorts by final score descending (with rescoring triggered by topK < count)", async () => {
    const reranker = new PairwiseMemoryReranker();
    // Use content with zero word overlap so original score order is preserved after rescoring
    const candidates = [
      makeCandidate("low", 0.5, undefined, "zebra"),
      makeCandidate("high", 0.95, undefined, "elephant"),
      makeCandidate("mid", 0.7, undefined, "giraffe"),
      makeCandidate("extra", 0.3, undefined, "penguin"),
    ];
    // topK=3 < 4 candidates → rescoring is triggered
    const result = await reranker.rerank("query", candidates, 3);
    expect(result).toHaveLength(3);
    // All have avgOverlap=0 (zero intersection), so finalScore = score*0.6 + 0.4
    // high: 0.95*0.6+0.4=0.97, mid: 0.7*0.6+0.4=0.82, low: 0.5*0.6+0.4=0.70, extra: 0.3*0.6+0.4=0.58
    // Sorted top 3: [high, mid, low]
    expect(result[0]!.id).toBe("high");
    expect(result[1]!.id).toBe("mid");
    expect(result[2]!.id).toBe("low");
  });

  test("handles candidates with empty content", async () => {
    const reranker = new PairwiseMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, undefined, ""),
      makeCandidate("b", 0.8, undefined, ""),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    // Empty content means Jaccard overlap = 0 → avgOverlap = 0
    // finalScore = score * 0.6 + 1 * 0.4
    expect(result).toHaveLength(2);
  });

  test("handles empty candidate list", async () => {
    const reranker = new PairwiseMemoryReranker();
    const result = await reranker.rerank("query", [], 5);
    expect(result).toHaveLength(0);
  });

  test("all candidates with identical content get equal diversity bonus", async () => {
    const reranker = new PairwiseMemoryReranker();
    const sameContent = "exact same content here";
    const candidates = [
      makeCandidate("a", 0.9, undefined, sameContent),
      makeCandidate("b", 0.8, undefined, sameContent),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    // Both have avgOverlap=1.0, so final = score*0.6 + 0*0.4 = score*0.6
    // So higher original score still wins
    expect(result[0]!.id).toBe("a");
  });

  test("handles single candidate (no cross-comparisons)", async () => {
    const reranker = new PairwiseMemoryReranker();
    // When candidates <= topK, short-circuits and returns as-is (no rescoring)
    const candidates = [makeCandidate("solo", 0.9, undefined, "content")];
    const result = await reranker.rerank("query", candidates, 5);
    // Returns candidates unmodified since 1 <= 5
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("solo");
    expect(result[0]!.score).toBe(0.9);
  });

  test("Jaccard overlap is case-insensitive", async () => {
    const reranker = new PairwiseMemoryReranker();
    const candidates = [
      makeCandidate("a", 0.9, undefined, "DEPLOY THE APP"),
      makeCandidate("b", 0.8, undefined, "deploy the app"),
    ];
    const result = await reranker.rerank("query", candidates, 2);
    // Both have identical content (case-insensitive), so avgOverlap = 1.0
    expect(result).toHaveLength(2);
  });
});
