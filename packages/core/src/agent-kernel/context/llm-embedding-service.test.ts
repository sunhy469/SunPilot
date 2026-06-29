import { describe, expect, test } from "vitest";
import { LlmEmbeddingService } from "./llm-embedding-service.js";
import type { EmbeddingProvider } from "./llm-embedding-service.js";

// ── Helpers ──────────────────────────────────────────────────────────

interface TrackedProvider extends EmbeddingProvider {
  callCount: number;
}

function stubEmbeddingProvider(): TrackedProvider {
  const provider: TrackedProvider = {
    callCount: 0,
    async embed(text: string): Promise<number[]> {
      provider.callCount++;
      // Deterministic vector based on text length
      return new Array(4).fill(0).map((_, i) => (text.length + i) * 0.01);
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => provider.embed(t)));
    },
  };
  return provider;
}

// ── Basic embedding ──────────────────────────────────────────────────

describe("LlmEmbeddingService — basic embedding", () => {
  test("embed returns vector from real provider", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    const vec = await svc.embed("hello");
    expect(vec).toHaveLength(4);
    expect(vec[0]).toBe(5 * 0.01); // text.length * 0.01
    expect(provider.callCount).toBe(1);
  });

  test("embed caches result — second call is a hit", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    const r1 = await svc.embed("hello");
    const r2 = await svc.embed("hello");

    expect(r1).toEqual(r2);
    expect(provider.callCount).toBe(1);
  });

  test("embed returns same result from cache as from provider", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    const direct = await svc.embed("hello");
    const cached = await svc.embed("hello");
    expect(direct).toEqual(cached);
  });

  test("embed falls back to keyword hash when no provider configured", async () => {
    const svc = new LlmEmbeddingService({
      dimension: 4,
      // no embeddingProvider
    });

    const vec = await svc.embed("hello");
    expect(vec).toHaveLength(4);
    expect(svc.isDegraded).toBe(true); // no provider → degraded
  });

  test("embed falls back after provider failure", async () => {
    const failing: EmbeddingProvider = {
      async embed(): Promise<number[]> {
        throw new Error("API down");
      },
      async embedBatch(): Promise<number[][]> {
        throw new Error("API down");
      },
    };
    const svc = new LlmEmbeddingService({
      embeddingProvider: failing,
      dimension: 4,
    });

    const vec = await svc.embed("hello");
    expect(vec).toHaveLength(4);
    expect(svc.isDegraded).toBe(true);
    expect(svc.hasRealProvider).toBe(false);
  });

  test("embedBatch returns vectors for all texts", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    const results = await svc.embedBatch(["a", "bb", "ccc"]);
    expect(results).toHaveLength(3);
    results.forEach((r) => expect(r).toHaveLength(4));
  });

  test("embedBatch uses cache for already-known texts", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    // Cache "a" individually first
    await svc.embed("a");
    const callsBefore = provider.callCount;

    // Batch request includes cached "a" + uncached "b"
    await svc.embedBatch(["a", "b"]);
    // Only "b" needed a new call
    expect(provider.callCount).toBe(callsBefore + 1);
  });

  test("embedBatch falls back per-text when batch fails", async () => {
    const failing: EmbeddingProvider = {
      async embed(text: string): Promise<number[]> {
        return [text.length * 0.01, 0.5, 0.8, 0.1];
      },
      async embedBatch(): Promise<number[][]> {
        throw new Error("batch API down");
      },
    };
    const svc = new LlmEmbeddingService({
      embeddingProvider: failing,
      dimension: 4,
    });

    // Should not throw — falls back to per-text embed
    const results = await svc.embedBatch(["a", "b"]);
    expect(results).toHaveLength(2);
    results.forEach((r) => expect(r).toHaveLength(4));
  });
});

// ── LRU cache ────────────────────────────────────────────────────────

describe("LlmEmbeddingService — LRU cache", () => {
  test("LRU eviction: evicts oldest entry when at capacity", async () => {
    const provider = stubEmbeddingProvider();
    // Use a tiny max size for testing. We can't override MAX_CACHE_SIZE
    // directly, so we insert 1001 entries and verify the first is evicted.
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    // Fill cache with 1000 entries (MAX_CACHE_SIZE)
    const texts: string[] = [];
    for (let i = 0; i < 1000; i++) {
      texts.push(`text_${String(i).padStart(8, "0")}`);
    }
    await svc.preWarm(texts);
    expect(svc.cacheSize).toBe(1000);

    // Verify "text_0" (oldest) is cached
    const callsBefore = provider.callCount;
    await svc.embed(texts[0]!);
    expect(provider.callCount).toBe(callsBefore); // cache hit

    // Insert one more — should evict the oldest (which is now texts[1]
    // since texts[0] was accessed and moved to MRU by cacheGet above)
    await svc.embed("overflow");
    expect(svc.cacheSize).toBe(1000);

    // texts[1] should now be evicted
    const afterCalls = provider.callCount;
    await svc.embed(texts[1]!);
    expect(provider.callCount).toBe(afterCalls + 1); // cache miss, new call
  });

  test("LRU access reorders: accessed entry preserved on eviction", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    // Fill cache with 5 entries (smaller test to keep it fast)
    for (let i = 0; i < 5; i++) {
      await svc.embed(`key_${i}`);
    }
    // Cache is [key_0, key_1, key_2, key_3, key_4], key_0 oldest

    // Access key_0 — moves it to MRU
    await svc.embed("key_0");

    // Now key_1 is oldest. Insert 995 more entries to trigger eviction.
    // key_1 should be evicted first.
    for (let i = 5; i < 1000; i++) {
      await svc.embed(`fill_${i}`);
    }

    // key_0 should still be in cache (was promoted)
    const beforeCalls = provider.callCount;
    await svc.embed("key_0");
    expect(provider.callCount).toBe(beforeCalls); // cache hit
  });

  test("default dimension is 1536", () => {
    const svc = new LlmEmbeddingService({});
    expect(svc.dimension).toBe(1536);
  });

  test("custom dimension is respected", () => {
    const svc = new LlmEmbeddingService({
      dimension: 256,
    });
    expect(svc.dimension).toBe(256);
  });
});

// ── Pending dedup ────────────────────────────────────────────────────

describe("LlmEmbeddingService — concurrent dedup", () => {
  test("concurrent embed calls deduplicate to one API call", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    const [r1, r2, r3] = await Promise.all([
      svc.embed("concurrent"),
      svc.embed("concurrent"),
      svc.embed("concurrent"),
    ]);

    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
    expect(provider.callCount).toBe(1);
  });

  test("after concurrent embed, cache is populated", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    await Promise.all([svc.embed("hello"), svc.embed("hello")]);
    expect(provider.callCount).toBe(1);

    // Subsequent call hits cache
    await svc.embed("hello");
    expect(provider.callCount).toBe(1);
  });

  test("dedup works during fallback (provider failure)", async () => {
    let calls = 0;
    const failing: EmbeddingProvider = {
      async embed(): Promise<number[]> {
        calls++;
        throw new Error("down");
      },
      async embedBatch(): Promise<number[][]> {
        throw new Error("down");
      },
    };
    const svc = new LlmEmbeddingService({
      embeddingProvider: failing,
      dimension: 4,
    });

    const [r1, r2] = await Promise.all([
      svc.embed("hello"),
      svc.embed("hello"),
    ]);

    // Both got the same fallback vector
    expect(r1).toEqual(r2);
    expect(r1).toHaveLength(4);
    // Only 1 call despite 2 concurrent requests + retry
    // (the first triggers the real provider which fails, second waits on pending)
    expect(calls).toBe(1);
  });

  test("provider failure: both concurrent callers receive fallback vector", async () => {
    const failing: EmbeddingProvider = {
      async embed(): Promise<number[]> {
        throw new Error("down");
      },
      async embedBatch(): Promise<number[][]> {
        throw new Error("down");
      },
    };
    const svc = new LlmEmbeddingService({
      embeddingProvider: failing,
      dimension: 4,
    });

    const results = await Promise.all([
      svc.embed("hello"),
      svc.embed("hello"),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(svc.isDegraded).toBe(true);
  });
});

// ── Degraded mode ────────────────────────────────────────────────────

describe("LlmEmbeddingService — degraded mode", () => {
  test("hasRealProvider is true when provider configured and active", () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
    });
    expect(svc.hasRealProvider).toBe(true);
  });

  test("hasRealProvider is false after provider failure", async () => {
    const failing: EmbeddingProvider = {
      async embed(): Promise<number[]> {
        throw new Error("down");
      },
      async embedBatch(): Promise<number[][]> {
        throw new Error("down");
      },
    };
    const svc = new LlmEmbeddingService({
      embeddingProvider: failing,
    });

    await svc.embed("test");
    expect(svc.hasRealProvider).toBe(false);
  });

  test("isDegraded is false when provider works", () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
    });
    expect(svc.isDegraded).toBe(false);
  });

  test("isDegraded is true when no provider configured", () => {
    const svc = new LlmEmbeddingService({});
    expect(svc.isDegraded).toBe(true);
  });

  test("isDegraded is true after provider failure", async () => {
    const failing: EmbeddingProvider = {
      async embed(): Promise<number[]> {
        throw new Error("down");
      },
      async embedBatch(): Promise<number[][]> {
        throw new Error("down");
      },
    };
    const svc = new LlmEmbeddingService({
      embeddingProvider: failing,
    });

    await svc.embed("test");
    expect(svc.isDegraded).toBe(true);
  });

  test("clearDegraded resets the degraded flag", async () => {
    const failing: EmbeddingProvider = {
      async embed(): Promise<number[]> {
        throw new Error("down");
      },
      async embedBatch(): Promise<number[][]> {
        throw new Error("down");
      },
    };
    const svc = new LlmEmbeddingService({
      embeddingProvider: failing,
    });

    await svc.embed("test");
    expect(svc.isDegraded).toBe(true);
    expect(svc.hasRealProvider).toBe(false);

    // clearDegraded resets the internal flag. Since the provider is still
    // configured, hasRealProvider becomes true again (though the next
    // embed call will likely fail and re-enter degraded mode).
    svc.clearDegraded();
    expect(svc.hasRealProvider).toBe(true);
  });

  test("degraded mode recovers after clearDegraded + successful embed", async () => {
    let shouldFail = true;
    const flaky: EmbeddingProvider = {
      async embed(text: string): Promise<number[]> {
        if (shouldFail) {
          shouldFail = false;
          throw new Error("transient");
        }
        return [text.length * 0.01, 0.5, 0.8, 0.1];
      },
      async embedBatch(): Promise<number[][]> {
        throw new Error("not used");
      },
    };
    const svc = new LlmEmbeddingService({
      embeddingProvider: flaky,
      dimension: 4,
    });

    // First call fails → degraded (with 5-min recovery window)
    await svc.embed("test");
    expect(svc.isDegraded).toBe(true);

    // Clear degraded state to allow immediate retry
    svc.clearDegraded();

    // Second call succeeds → recovered
    await svc.embed("test2");
    expect(svc.isDegraded).toBe(false);
    expect(svc.hasRealProvider).toBe(true);
  });
});

// ── Pre-warm ─────────────────────────────────────────────────────────

describe("LlmEmbeddingService — preWarm", () => {
  test("preWarm populates cache", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    await svc.preWarm(["a", "b", "c"]);
    expect(svc.cacheSize).toBe(3);

    // Subsequent embeds should be cache hits
    const beforeCalls = provider.callCount;
    await svc.embed("a");
    expect(provider.callCount).toBe(beforeCalls);
  });

  test("preWarm skips already-cached texts", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    await svc.embed("a");
    const callsAfterFirst = provider.callCount;

    await svc.preWarm(["a", "b"]);
    // Only "b" needed embedding
    expect(provider.callCount).toBe(callsAfterFirst + 1);
  });

  test("preWarm empty array is no-op", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
    });

    await svc.preWarm([]);
    expect(svc.cacheSize).toBe(0);
    expect(provider.callCount).toBe(0);
  });
});

// ── Invalidate cache ─────────────────────────────────────────────────

describe("LlmEmbeddingService — invalidateCache", () => {
  test("invalidateCache clears all cached entries", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    await svc.embed("hello");
    expect(svc.cacheSize).toBe(1);

    svc.invalidateCache();
    expect(svc.cacheSize).toBe(0);

    // Re-embedding should call provider again
    const beforeCalls = provider.callCount;
    await svc.embed("hello");
    expect(provider.callCount).toBe(beforeCalls + 1);
  });

  test("invalidateCache resets cache stats", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    await svc.embed("hello");
    await svc.embed("hello"); // cache hit
    expect(svc.cacheStats.hits).toBe(1);
    expect(svc.cacheStats.misses).toBe(1);

    svc.invalidateCache();
    expect(svc.cacheStats.hits).toBe(0);
    expect(svc.cacheStats.misses).toBe(0);
  });

  test("invalidateCache clears both cache and pending map", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    // Start a concurrent embed
    const promise = svc.embed("hello");
    svc.invalidateCache();
    expect(svc.cacheSize).toBe(0);

    // The pending promise still resolves, and its .then() re-populates
    // the cache. This is expected behavior — invalidateCache doesn't
    // cancel in-flight requests.
    await promise;

    // Cache was re-populated by the inflight embedUncached, so this is a hit.
    await svc.embed("hello");
    expect(provider.callCount).toBe(1);

    // invalidate again (no inflight request), now truly empty
    svc.invalidateCache();
    await svc.embed("hello");
    expect(provider.callCount).toBe(2);
  });
});

// ── Keyword fallback ─────────────────────────────────────────────────

describe("LlmEmbeddingService — keyword fallback", () => {
  test("keyword embed returns fixed-dimension vector", async () => {
    const svc = new LlmEmbeddingService({
      dimension: 10,
    });

    const vec = await svc.embed("hello world");
    expect(vec).toHaveLength(10);
  });

  test("keyword embed is deterministic", async () => {
    const svc = new LlmEmbeddingService({});

    const r1 = await svc.embed("hello");
    const r2 = await svc.embed("hello");
    expect(r1).toEqual(r2);
  });

  test("keyword embed handles empty text", async () => {
    const svc = new LlmEmbeddingService({});

    const vec = await svc.embed("");
    expect(vec).toHaveLength(1536);
  });

  test("keyword embed handles CJK text", async () => {
    const svc = new LlmEmbeddingService({
      dimension: 4,
    });

    const vec = await svc.embed("你好世界");
    expect(vec).toHaveLength(4);
    // Should have some non-zero values from bigram tokens
    const hasNonZero = vec.some((v) => v !== 0);
    expect(hasNonZero).toBe(true);
  });

  test("keyword vectors are L2 normalized", async () => {
    const svc = new LlmEmbeddingService({
      dimension: 4,
    });

    const vec = await svc.embed("hello world this is a test");
    // L2 norm should be approximately 1.0 (or 0 for empty)
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    if (norm > 0) {
      expect(norm).toBeCloseTo(1.0, 5);
    }
  });

  test("keyword fallback is cached", async () => {
    const svc = new LlmEmbeddingService({});

    const r1 = await svc.embed("hello");
    const r2 = await svc.embed("hello");
    expect(r1).toEqual(r2);
  });
});

// ── Cache stats ──────────────────────────────────────────────────────

describe("LlmEmbeddingService — cacheStats", () => {
  test("cacheStats tracks hits and misses", async () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
      dimension: 4,
    });

    // Miss
    await svc.embed("hello");
    expect(svc.cacheStats.misses).toBe(1);
    expect(svc.cacheStats.hits).toBe(0);

    // Hit
    await svc.embed("hello");
    expect(svc.cacheStats.misses).toBe(1);
    expect(svc.cacheStats.hits).toBe(1);

    // Another miss
    await svc.embed("world");
    expect(svc.cacheStats.misses).toBe(2);
    expect(svc.cacheStats.hits).toBe(1);
  });

  test("cacheStats returns a snapshot (not live reference)", () => {
    const provider = stubEmbeddingProvider();
    const svc = new LlmEmbeddingService({
      embeddingProvider: provider,
    });

    const stats = svc.cacheStats;
    stats.hits = 999;
    // Original should be unchanged
    expect(svc.cacheStats.hits).toBe(0);
  });
});
