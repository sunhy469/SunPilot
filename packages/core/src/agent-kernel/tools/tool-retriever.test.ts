/**
 * Unit tests for ToolRetriever — validates embedding gating and
 * degradation behavior to prevent cross-mode vector contamination.
 */

import { describe, expect, test } from "vitest";
import { ToolRetriever } from "./tool-retriever.js";
import type { SkillSummary } from "./tool-types.js";
import type { EmbeddingService } from "../context/embedding-service.js";
import type { RoutedIntent } from "../loop-types.js";

// ── Helpers ────────────────────────────────────────────────────────

function makeSkill(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: "test:search",
    name: "Search Tool",
    description: "Search for products by keyword.",
    category: "web",
    enabled: true,
    permissions: ["network.request"],
    defaultTimeoutMs: 10_000,
    maxTimeoutMs: 30_000,
    supportsAbort: true,
    idempotent: true,
    riskHints: { defaultRisk: "medium" },
    ...overrides,
  };
}

function makeIntent(): RoutedIntent {
  return {
    type: "use_skill",
    confidence: 0.8,
    requiresPlanning: false,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "medium",
    candidateSkills: [],
    reason: "test",
  };
}

/** Create a mock EmbeddingService that returns real-looking vectors. */
function realEmbeddingService(): EmbeddingService {
  let degraded = false;
  return {
    hasRealProvider: true,
    get isDegraded() { return degraded; },
    async embed(_text: string): Promise<number[]> {
      // Simulate real vectors (dummy but deterministic)
      const vec = new Array(128).fill(0.01);
      vec[0] = 0.9;
      return vec;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => this.embed(t)));
    },
  };
}

/** Create a mock EmbeddingService that starts real but degrades on first call. */
function degradingEmbeddingService(): EmbeddingService {
  let degraded = false;
  return {
    get hasRealProvider() { return !degraded; },
    get isDegraded() { return degraded; },
    async embed(_text: string): Promise<number[]> {
      // Simulate provider failure: mark degraded and return hash-like vector
      degraded = true;
      // Return a vector very different from the "real" dummy vectors above
      const vec = new Array(128).fill(0.005);
      vec[0] = 0.1;
      return vec;
    },
    async embedBatch(texts: string[]): Promise<number[][]> {
      return Promise.all(texts.map((t) => this.embed(t)));
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("ToolRetriever", () => {
  describe("embedding gating", () => {
    test("real embedding service adds semantic score and reason", async () => {
      const retriever = new ToolRetriever();
      const embeddingService = realEmbeddingService();

      const result = await retriever.retrieve({
        query: "find products",
        intent: makeIntent(),
        availableSkills: [makeSkill()],
        embeddingService,
      });

      expect(result.tools).toHaveLength(1);
      const tool = result.tools[0]!;
      // Should have semantic match reason from real embedding
      expect(tool.matchReasons).toContainEqual(
        expect.stringMatching(/^semantic:/),
      );
      // Score should include embedding boost (keyword overlap + embedding * 0.5)
      expect(tool.score).toBeGreaterThan(0.3);
    });

    test("degraded embedding service does NOT add semantic score", async () => {
      const retriever = new ToolRetriever();
      const embeddingService = degradingEmbeddingService();

      const result = await retriever.retrieve({
        query: "find products",
        intent: makeIntent(),
        availableSkills: [makeSkill()],
        embeddingService,
      });

      expect(result.tools).toHaveLength(1);
      const tool = result.tools[0]!;
      // Must NOT have semantic match reason
      const semanticReasons = tool.matchReasons.filter((r) =>
        r.startsWith("semantic:"),
      );
      expect(semanticReasons).toHaveLength(0);
      // Score should be keyword-only (no 0.5 embedding boost)
      expect(tool.score).toBeLessThan(0.3);
    });

    test("no embedding service skips embedding layer entirely", async () => {
      const retriever = new ToolRetriever();

      const result = await retriever.retrieve({
        query: "find products",
        intent: makeIntent(),
        availableSkills: [makeSkill()],
        // No embeddingService provided
      });

      expect(result.tools).toHaveLength(1);
      const tool = result.tools[0]!;
      const semanticReasons = tool.matchReasons.filter((r) =>
        r.startsWith("semantic:"),
      );
      expect(semanticReasons).toHaveLength(0);
    });

    test("degradation during query embed prevents contamination with cached real skill vectors", async () => {
      // Simulate: skills were pre-cached with real vectors, but the
      // query embedding call fails and falls back to hash. The similarity
      // between a real skill vector and a hash query vector is meaningless.
      const retriever = new ToolRetriever();
      let callCount = 0;
      const embeddingService: EmbeddingService = {
        get hasRealProvider() { return callCount === 0; },
        get isDegraded() { return callCount > 0; },
        async embed(_text: string): Promise<number[]> {
          callCount++;
          if (callCount === 1) {
            // First call (query embed) — fails and degrades
            // Return a hash-like vector, very different from real
            const vec = new Array(128).fill(0.002);
            vec[0] = 0.05;
            return vec;
          }
          // Subsequent calls (skill embed) — these would be "cached real"
          // vectors in production. Return a real-looking vector.
          const vec = new Array(128).fill(0.01);
          vec[0] = 0.9;
          return vec;
        },
        async embedBatch(texts: string[]): Promise<number[][]> {
          return Promise.all(texts.map((t) => this.embed(t)));
        },
      };

      const result = await retriever.retrieve({
        query: "find products",
        intent: makeIntent(),
        availableSkills: [
          makeSkill({ id: "s1", name: "Skill A", description: "Desc A" }),
          makeSkill({ id: "s2", name: "Skill B", description: "Desc B" }),
        ],
        embeddingService,
      });

      // Both skills should have NO semantic match reasons and NO 0.5 boost
      for (const tool of result.tools) {
        const semanticReasons = tool.matchReasons.filter((r) =>
          r.startsWith("semantic:"),
        );
        expect(semanticReasons).toHaveLength(0);
        // Score should be keyword-only (< 0.3 with no embedding boost)
        expect(tool.score).toBeLessThan(0.3);
      }
    });
  });
});
