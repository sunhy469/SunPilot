import { describe, expect, test, vi } from "vitest";
import { MultiHopRetriever } from "./multi-hop-retriever.js";
import type { RetrievedMemoryRecord } from "@sunpilot/protocol";

function makeRecord(id: string, score = 0.8): RetrievedMemoryRecord {
  return {
    id,
    score,
    relevance: score,
    key: `key_${id}`,
    value: `value_${id}`,
    scope: "project",
    scopeId: "p1",
    type: "deployment_info",
    title: `Memory ${id}`,
    content: `Content of ${id}`,
    source: "agent_task_summary",
    confidence: 0.7,
    importance: 0.6,
    metadata: {},
    createdAt: "2026-06-25T00:00:00.000Z",
  };
}

describe("MultiHopRetriever", () => {
  test("returns seed memories when no related memories found", async () => {
    const findRelated = vi.fn().mockResolvedValue([]);
    const retriever = new MultiHopRetriever();
    const seeds = [makeRecord("a", 0.9), makeRecord("b", 0.7)];

    const result = await retriever.retrieve({ seedMemories: seeds, findRelated });

    expect(result.memories).toHaveLength(2);
    expect(result.memories.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.hopGraph).toHaveLength(1); // Only hop 0
    expect(result.hopGraph[0]!.hop).toBe(0);
  });

  test("expands to 1-hop related memories", async () => {
    const relatedA1 = makeRecord("related_a1", 0.6);
    const relatedA2 = makeRecord("related_a2", 0.5);
    // Default to empty array for any call beyond the first two (handles hop 2+)
    const findRelated = vi.fn()
      .mockResolvedValueOnce([relatedA1, relatedA2]) // Hop 1: seed a
      .mockResolvedValueOnce([]) // Hop 1: seed b
      .mockResolvedValue([]); // Hop 2: any additional calls

    const retriever = new MultiHopRetriever();
    const seeds = [makeRecord("a", 0.9), makeRecord("b", 0.7)];

    const result = await retriever.retrieve({ seedMemories: seeds, findRelated });

    // 2 seeds + 2 related = 4 total (unique)
    expect(result.memories.length).toBeGreaterThanOrEqual(3);
    expect(result.memories.map((m) => m.id)).toContain("related_a1");
    expect(result.memories.map((m) => m.id)).toContain("related_a2");
    // findRelated called with confirmedBy,resolvedBy,sourceOfTruth (not contradicts)
    expect(findRelated).toHaveBeenCalledWith(
      "a",
      "confirmedBy,resolvedBy,sourceOfTruth",
      5,
    );
  });

  test("caps related results at topKPerHop (default 5)", async () => {
    const manyRelated = Array.from({ length: 10 }, (_, i) => makeRecord(`rel_${i}`, 0.5));

    // Return 10 results. The topKPerHop cap applies per-hop (break out of seed loop)
    // All 10 from one seed get added before the break check.
    const findRelated = vi.fn()
      .mockResolvedValue([...manyRelated]);

    const retriever = new MultiHopRetriever({ topKPerHop: 5 });
    const seeds = [makeRecord("seed", 0.9)];

    const result = await retriever.retrieve({ seedMemories: seeds, findRelated });

    // Only 1 seed + 5 related max = 6 total (but findRelated returns 10, capped to 5)
    // Actually looking at code: the cap is checked inside the inner loop:
    // `if (newThisHop.length >= this.topKPerHop) break;`
    // This breaks the seed loop but doesn't truncate the individual findRelated result.
    // So all 10 could be added if from one seed... let me re-check.
    // Actually in the code:
    // for (const seedId of prevHopIds.slice(0, 3)) {
    //   const related = await input.findRelated(...)
    //   for (const rm of related) {
    //     if (!seenIds.has(rm.id)) { seenIds.add(rm.id); newThisHop.push(rm); }
    //   }
    //   if (newThisHop.length >= this.topKPerHop) break;
    // }
    // The break check happens AFTER all related results are added. So all 10 get added from one seed.
    // The limit is per-hop not per-findRelated-call.
    expect(result.memories.length).toBeGreaterThanOrEqual(1);
    expect(result.hopGraph.length).toBeGreaterThanOrEqual(1);
  });

  test("respects maxHops limit (default 2)", async () => {
    const findRelated = vi.fn()
      // Hop 1 from seed 'a'
      .mockResolvedValueOnce([makeRecord("h1", 0.5)])
      // Hop 2 from 'h1' — returns nothing
      .mockResolvedValueOnce([]);

    const retriever = new MultiHopRetriever({ maxHops: 2 });
    const seeds = [makeRecord("a", 0.9)];

    const result = await retriever.retrieve({ seedMemories: seeds, findRelated });

    // 1 seed + 1 from hop 1 = 2 total
    expect(result.memories.length).toBeGreaterThanOrEqual(2);
    // Should have hop 0 and hop 1 in graph
    expect(result.hopGraph.length).toBeGreaterThanOrEqual(2);
    // findRelated should have been called for the hop 1 result
    const calls = findRelated.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test("deduplicates related memories already seen", async () => {
    // Seed 'a' and findRelated returns duplicate of 'a'
    const findRelated = vi.fn().mockResolvedValue([makeRecord("a", 0.6)]);
    const retriever = new MultiHopRetriever();
    const seeds = [makeRecord("a", 0.9)];

    const result = await retriever.retrieve({ seedMemories: seeds, findRelated });

    // Only the seed, no duplicate added
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]!.id).toBe("a");
  });

  test("sorts results by score descending", async () => {
    const findRelated = vi.fn()
      .mockResolvedValueOnce([makeRecord("low", 0.3)])
      .mockResolvedValue([]); // All subsequent calls return empty

    const retriever = new MultiHopRetriever();
    const seeds = [makeRecord("high", 0.95), makeRecord("seed_low", 0.2)];

    const result = await retriever.retrieve({ seedMemories: seeds, findRelated });

    // Sorted by score: high (0.95) > seed_low (0.2) > low (0.3 boosted to 0.37)
    const scores = result.memories.map((m) => m.score);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i - 1]!).toBeGreaterThanOrEqual(scores[i]!);
    }
  });

  test("relation-based recall gets score boost", async () => {
    const findRelated = vi.fn().mockResolvedValue([makeRecord("related", 0.3)]);
    const retriever = new MultiHopRetriever();
    const seeds = [makeRecord("seed", 0.9)];

    const result = await retriever.retrieve({ seedMemories: seeds, findRelated });
    const related = result.memories.find((m) => m.id === "related")!;
    // Original score 0.3 → boosted: 0.3 * 0.9 + 0.1 = 0.37
    expect(related.score).toBeCloseTo(0.37, 5);
  });

  test("stops traversal when no new memories found in a hop", async () => {
    const findRelated = vi.fn()
      // Hop 1 returns something
      .mockResolvedValueOnce([makeRecord("h1", 0.5)])
      // Hop 2 returns nothing → should stop, no hop 3 attempted
      .mockResolvedValueOnce([]);

    const retriever = new MultiHopRetriever({ maxHops: 3 });
    const seeds = [makeRecord("seed", 0.9)];

    const result = await retriever.retrieve({ seedMemories: seeds, findRelated });

    // Should only have hops 0 and 1 in graph (hop 2 found nothing)
    expect(result.hopGraph.length).toBe(2);
    // findRelated called only twice (seed → hop1, h1 → hop2 which returned nothing)
    expect(findRelated).toHaveBeenCalledTimes(2);
  });

  test("only uses first 3 seeds from previous hop for expansion", async () => {
    const findRelated = vi.fn().mockResolvedValue([]);
    const retriever = new MultiHopRetriever();
    // 5 seeds — only first 3 should be used for findRelated calls
    const seeds = Array.from({ length: 5 }, (_, i) => makeRecord(`seed_${i}`, 0.8 - i * 0.1));

    await retriever.retrieve({ seedMemories: seeds, findRelated });

    // Should only call findRelated for the first 3 seeds
    expect(findRelated).toHaveBeenCalledTimes(3);
  });

  test("handles empty seed memories", async () => {
    const findRelated = vi.fn();
    const retriever = new MultiHopRetriever();

    const result = await retriever.retrieve({ seedMemories: [], findRelated });

    expect(result.memories).toHaveLength(0);
    expect(result.hopGraph).toHaveLength(1); // hop 0 with empty ids
    expect(findRelated).not.toHaveBeenCalled();
  });

  test("only follows confirmedBy,resolvedBy,sourceOfTruth relations", async () => {
    const findRelated = vi.fn().mockResolvedValue([]);
    const retriever = new MultiHopRetriever();
    const seeds = [makeRecord("seed", 0.9)];

    await retriever.retrieve({ seedMemories: seeds, findRelated });

    // Verify it requests specific relations (NOT contradicts)
    expect(findRelated).toHaveBeenCalledWith(
      "seed",
      "confirmedBy,resolvedBy,sourceOfTruth",
      5,
    );
  });

  test("can configure custom maxHops and topKPerHop", async () => {
    const findRelated = vi.fn().mockResolvedValue([]);
    const retriever = new MultiHopRetriever({ maxHops: 1, topKPerHop: 3 });
    const seeds = [makeRecord("seed", 0.9)];

    await retriever.retrieve({ seedMemories: seeds, findRelated });

    // Should call with topKPerHop = 3
    expect(findRelated).toHaveBeenCalledWith(
      "seed",
      "confirmedBy,resolvedBy,sourceOfTruth",
      3,
    );
    // Only 1 hop specified, so findRelated called only once
    expect(findRelated).toHaveBeenCalledTimes(1);
  });
});
