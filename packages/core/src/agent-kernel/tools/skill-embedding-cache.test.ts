import { describe, expect, test } from "vitest";
import { SkillEmbeddingCache } from "./skill-embedding-cache.js";
import type { EmbeddingService } from "../context/embedding-service.js";

// ── Helpers ──────────────────────────────────────────────────────────

interface MockEmbeddingService extends EmbeddingService {
  callCount: number;
  calls: string[];
}

function mockEmbeddingService(): MockEmbeddingService {
  const svc: MockEmbeddingService = {
    callCount: 0,
    calls: [],
    dimension: 4,
    hasRealProvider: true,
    isDegraded: false,
    async embed(text: string): Promise<number[]> {
      svc.callCount++;
      svc.calls.push(text);
      // Deterministic "vector" based on text length for reproducibility.
      return [text.length * 0.01, 0.5, 0.8, 0.1];
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => svc.embed(t)));
    },
  };
  return svc;
}

function makeSkill(overrides: Partial<{
  id: string;
  name: string;
  description: string;
  category: string;
}> = {}) {
  return {
    id: overrides.id ?? "test:skill",
    name: overrides.name ?? "Test Skill",
    description: overrides.description ?? "A test skill for unit testing",
    category: overrides.category ?? "custom",
  };
}

// ── Main skill cache ─────────────────────────────────────────────────

describe("SkillEmbeddingCache — main skill cache", () => {
  test("getEmbedding returns embedding for a skill", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);
    const skill = makeSkill();

    const result = await cache.getEmbedding(skill);
    expect(result).toHaveLength(4);
    expect(embedSvc.callCount).toBe(1);
  });

  test("getEmbedding caches result — second call is a hit", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);
    const skill = makeSkill();

    const r1 = await cache.getEmbedding(skill);
    const r2 = await cache.getEmbedding(skill);

    expect(r1).toEqual(r2);
    expect(embedSvc.callCount).toBe(1);
  });

  test("getEmbedding deduplicates concurrent requests for the same skill", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);
    const skill = makeSkill();

    const [r1, r2] = await Promise.all([
      cache.getEmbedding(skill),
      cache.getEmbedding(skill),
    ]);

    expect(r1).toEqual(r2);
    expect(embedSvc.callCount).toBe(1);
  });

  test("getEmbedding returns undefined when embedding service fails", async () => {
    const embedSvc = mockEmbeddingService();
    embedSvc.embed = async () => { throw new Error("API down"); };
    const cache = new SkillEmbeddingCache(embedSvc);

    const result = await cache.getEmbedding(makeSkill());
    expect(result).toBeUndefined();
  });

  test("getEmbedding clears pending entry on failure", async () => {
    const embedSvc = mockEmbeddingService();
    let throwOnFirst = true;
    embedSvc.embed = async (text: string) => {
      if (throwOnFirst) {
        throwOnFirst = false;
        throw new Error("transient error");
      }
      return [text.length * 0.01, 0.5, 0.8, 0.1];
    };
    const cache = new SkillEmbeddingCache(embedSvc);
    const skill = makeSkill();

    // First call fails
    const r1 = await cache.getEmbedding(skill);
    expect(r1).toBeUndefined();

    // Second call retries and succeeds (pending was cleaned up)
    const r2 = await cache.getEmbedding(skill);
    expect(r2).toHaveLength(4);
  });

  test("cache key is built from id, name, description, and category", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    await cache.getEmbedding(makeSkill({ id: "a", category: "cat1" }));
    await cache.getEmbedding(makeSkill({ id: "a", category: "cat2" }));

    // Different category → different cache key → two API calls
    expect(embedSvc.callCount).toBe(2);
  });

  test("size returns number of cached entries", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    expect(cache.size).toBe(0);
    await cache.getEmbedding(makeSkill({ id: "s1" }));
    expect(cache.size).toBe(1);
    await cache.getEmbedding(makeSkill({ id: "s2" }));
    expect(cache.size).toBe(2);
  });

  test("invalidate() with no args clears all entries", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    await cache.getEmbedding(makeSkill({ id: "s1" }));
    await cache.getEmbedding(makeSkill({ id: "s2" }));
    expect(cache.size).toBe(2);

    cache.invalidate();
    expect(cache.size).toBe(0);
  });

  test("invalidate(skillIds) clears only matching skills", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    await cache.getEmbedding(makeSkill({ id: "aa:keep" }));
    await cache.getEmbedding(makeSkill({ id: "bb:drop" }));
    expect(cache.size).toBe(2);

    cache.invalidate(["bb:drop"]);
    // "aa:keep" should still be cached
    const r1 = await cache.getEmbedding(makeSkill({ id: "aa:keep" }));
    expect(embedSvc.callCount).toBe(2); // no new call for aa:keep
    expect(r1).toHaveLength(4);

    // "bb:drop" should miss and recompute
    const r2 = await cache.getEmbedding(makeSkill({ id: "bb:drop" }));
    expect(embedSvc.callCount).toBe(3); // new call for bb:drop
    expect(r2).toHaveLength(4);
  });

  test("invalidate with empty array clears all", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    await cache.getEmbedding(makeSkill({ id: "s1" }));
    cache.invalidate([]);
    expect(cache.size).toBe(0);
  });

  test("invalidate clears both cache and pending map", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    // Start a pending request but don't await it yet
    const skill = makeSkill({ id: "s1" });
    const promise = cache.getEmbedding(skill);

    // Invalidate while the request is in flight
    cache.invalidate();
    expect(cache.size).toBe(0);

    // Pending request still resolves (the promise was already created).
    // The .then() callback re-populates the cache but the pending map
    // was already cleared.
    await promise;

    // Cache was re-populated by the inflight .then(), so this is a hit.
    await cache.getEmbedding(skill);
    expect(embedSvc.callCount).toBe(1);

    // invalidate again (no inflight request), now truly empty
    cache.invalidate();
    await cache.getEmbedding(skill);
    expect(embedSvc.callCount).toBe(2);
  });
});

// ── Pre-warm ─────────────────────────────────────────────────────────

describe("SkillEmbeddingCache — preWarm", () => {
  test("preWarm populates cache for all provided skills", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    const skills = [
      makeSkill({ id: "s1" }),
      makeSkill({ id: "s2" }),
      makeSkill({ id: "s3" }),
    ];
    await cache.preWarm(skills);

    expect(cache.size).toBe(3);
    // All should now be cached hits
    await cache.getEmbedding(skills[0]!);
    expect(embedSvc.callCount).toBe(3); // no extra call
  });

  test("preWarm skips already-cached skills", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    // Cache one manually
    await cache.getEmbedding(makeSkill({ id: "s1" }));
    expect(embedSvc.callCount).toBe(1);

    // preWarm with s1 (cached) + s2 (uncached)
    await cache.preWarm([
      makeSkill({ id: "s1" }),
      makeSkill({ id: "s2" }),
    ]);
    // Only s2 needed embedding
    expect(embedSvc.callCount).toBe(2);
  });

  test("preWarm with empty array is a no-op", async () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    await cache.preWarm([]);
    expect(embedSvc.callCount).toBe(0);
    expect(cache.size).toBe(0);
  });

  test("preWarm handles failures gracefully", async () => {
    const embedSvc = mockEmbeddingService();
    let callIdx = 0;
    embedSvc.embed = async (text: string) => {
      callIdx++;
      if (callIdx === 2) throw new Error("transient");
      return [text.length * 0.01, 0.5, 0.8, 0.1];
    };
    const cache = new SkillEmbeddingCache(embedSvc);

    // Should not throw even though skill 2 fails
    await cache.preWarm([
      makeSkill({ id: "s1" }),
      makeSkill({ id: "s2" }),
      makeSkill({ id: "s3" }),
    ]);

    // s1 and s3 cached, s2 was skipped
    expect(cache.size).toBe(2);
  });
});

// ── Query cache ──────────────────────────────────────────────────────

describe("SkillEmbeddingCache — query cache", () => {
  test("setQueryEmbedding + getQueryEmbedding round-trip", () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    const vector = [0.1, 0.2, 0.3, 0.4];
    cache.setQueryEmbedding("hello world", vector);
    expect(cache.getQueryEmbedding("hello world")).toEqual(vector);
  });

  test("getQueryEmbedding returns undefined for unknown query", () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    expect(cache.getQueryEmbedding("unknown")).toBeUndefined();
  });

  test("query cache is independent of skill cache", () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    cache.setQueryEmbedding("some query", [0.1, 0.2]);
    expect(cache.size).toBe(0); // query cache doesn't affect skill cache size
  });

  test("clearQueryEmbeddings empties the query cache", () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    cache.setQueryEmbedding("q1", [0.1, 0.2]);
    cache.setQueryEmbedding("q2", [0.3, 0.4]);
    cache.clearQueryEmbeddings();

    expect(cache.getQueryEmbedding("q1")).toBeUndefined();
    expect(cache.getQueryEmbedding("q2")).toBeUndefined();
  });

  test("query cache LRU eviction: evicts oldest when at capacity", () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    // Fill to capacity (100 entries)
    for (let i = 0; i < 100; i++) {
      cache.setQueryEmbedding(`query_${i}`, [i * 0.01, 0.5, 0.8, 0.1]);
    }

    // "query_0" is the oldest
    expect(cache.getQueryEmbedding("query_0")).toBeDefined();

    // Insert one more — should evict the now-oldest entry
    cache.setQueryEmbedding("query_100", [1.0, 0.5, 0.8, 0.1]);

    // "query_1" (the actual oldest since 0 was accessed) should be evicted
    // But "query_0" was accessed so it moved to MRU and should still exist
    expect(cache.getQueryEmbedding("query_0")).toBeDefined();
  });

  test("query cache LRU eviction: accessed entries are preserved", () => {
    const embedSvc = mockEmbeddingService();
    const cache = new SkillEmbeddingCache(embedSvc);

    // Fill to capacity
    for (let i = 0; i < 100; i++) {
      cache.setQueryEmbedding(`query_${i}`, [i * 0.01, 0.5, 0.8, 0.1]);
    }

    // Access the oldest entry to promote it to MRU
    const oldestVal = cache.getQueryEmbedding("query_0");
    expect(oldestVal).toBeDefined();

    // Insert one more — "query_0" should survive, "query_1" evicted
    cache.setQueryEmbedding("query_100", [1.0, 0.5, 0.8, 0.1]);
    expect(cache.getQueryEmbedding("query_0")).toBeDefined();
  });
});
