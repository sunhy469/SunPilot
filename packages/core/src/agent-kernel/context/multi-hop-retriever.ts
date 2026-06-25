import type { RetrievedMemoryRecord } from "@sunpilot/protocol";

/**
 * MultiHopRetriever — expands memory retrieval using relation-based graph traversal.
 *
 * Hop 0: Use initial search results as seed memories.
 * Hop 1: For each seed memory, find related memories via memory_relations table
 *         (confirmedBy, resolvedBy, sourceOfTruth relations only).
 *
 * Depth is capped at 2 hops and 5 results per hop to control noise.
 */
export interface MultiHopResult {
  memories: RetrievedMemoryRecord[];
  hopGraph: Array<{ hop: number; query: string; memoryIds: string[] }>;
}

export class MultiHopRetriever {
  private readonly maxHops: number;
  private readonly topKPerHop: number;

  constructor(opts: { maxHops?: number; topKPerHop?: number } = {}) {
    this.maxHops = opts.maxHops ?? 2;
    this.topKPerHop = opts.topKPerHop ?? 5;
  }

  async retrieve(input: {
    seedMemories: RetrievedMemoryRecord[];
    findRelated: (
      memoryId: string,
      relation?: string,
      limit?: number,
    ) => Promise<RetrievedMemoryRecord[]>;
  }): Promise<MultiHopResult> {
    const seenIds = new Set(input.seedMemories.map((m) => m.id));
    const allMemories = [...input.seedMemories];
    const hopGraph: MultiHopResult["hopGraph"] = [
      { hop: 0, query: "seed", memoryIds: input.seedMemories.map((m) => m.id) },
    ];

    for (let hop = 1; hop <= this.maxHops; hop++) {
      const prevHopIds = hopGraph[hop - 1]!.memoryIds;
      let newThisHop: RetrievedMemoryRecord[] = [];

      for (const seedId of prevHopIds.slice(0, 3)) {
        // Only follow confirmedBy/resolvedBy/sourceOfTruth — excludes contradicts
        const related = await input.findRelated(
          seedId,
          "confirmedBy,resolvedBy,sourceOfTruth",
          this.topKPerHop,
        );
        for (const rm of related) {
          if (!seenIds.has(rm.id)) {
            seenIds.add(rm.id);
            // §B10: shallow-copy with the boosted score instead of mutating
            // the caller-provided record. Boost: small relation-based lift.
            newThisHop.push({
              ...rm,
              score: (rm.score ?? 0.3) * 0.9 + 0.1,
            });
          }
        }
        if (newThisHop.length >= this.topKPerHop) break;
      }

      if (newThisHop.length === 0) break;

      allMemories.push(...newThisHop);
      hopGraph.push({
        hop,
        query: `relation-expansion-hop-${hop}`,
        memoryIds: newThisHop.map((m) => m.id),
      });
    }

    // Dedup and sort by score
    const unique = Array.from(
      new Map(allMemories.map((m) => [m.id, m])).values(),
    );
    unique.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return { memories: unique, hopGraph };
  }
}
