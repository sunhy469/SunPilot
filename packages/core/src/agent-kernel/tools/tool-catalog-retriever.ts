import type { EmbeddingService } from "../context/embedding-service.js";
import type { SkillEmbeddingCache } from "./skill-embedding-cache.js";
import type { SkillSummary } from "./tool-types.js";

export interface ToolCatalogResult {
  tools: Array<{
    skill: SkillSummary;
    score: number;
    matchReasons: string[];
  }>;
  topK: number;
  fallbackUsed: boolean;
  topKReason: string;
}

export interface ToolCatalogRetrieverDeps {
  embeddingService?: EmbeddingService;
  skillEmbeddingCache?: SkillEmbeddingCache;
}

/**
 * Intent-free candidate retrieval for the ReAct loop.
 *
 * This component only ranks capabilities. It never decides whether a tool
 * must be called and never creates executable arguments.
 */
export class ToolCatalogRetriever {
  constructor(private readonly deps: ToolCatalogRetrieverDeps = {}) {}

  async retrieve(input: {
    query: string;
    availableSkills: SkillSummary[];
    limit: number;
    permissionMode: "ask" | "auto" | "full";
  }): Promise<ToolCatalogResult> {
    const enabled = input.availableSkills.filter((skill) => skill.enabled);
    if (enabled.length === 0) {
      return {
        tools: [],
        topK: 0,
        fallbackUsed: false,
        topKReason: "no enabled tools",
      };
    }

    const query = input.query.trim();
    const queryLower = query.toLowerCase();
    const queryTokens = tokenize(queryLower);
    const scored = enabled.map((skill) => {
      const searchable = [
        skill.id,
        skill.name,
        skill.description,
        skill.category,
        ...(skill.examples ?? []),
        ...(skill.annotations?.tags ?? []),
      ].join(" ").toLowerCase();
      const searchableTokens = tokenize(searchable);
      const overlap = queryTokens.filter((token) =>
        searchableTokens.some(
          (candidate) => candidate === token || candidate.includes(token),
        ),
      );
      let score =
        overlap.length / Math.max(1, queryTokens.length) * 0.35;
      const reasons: string[] = [];
      if (overlap.length > 0) {
        reasons.push(`keyword:${overlap.slice(0, 5).join(",")}`);
      }
      if (
        queryLower.length > 1 &&
        (searchable.includes(queryLower) || queryLower.includes(skill.name.toLowerCase()))
      ) {
        score += 0.25;
        reasons.push("phrase_match");
      }

      const risk = skill.riskHints.defaultRisk;
      if (input.permissionMode === "ask" && risk === "low") {
        score += 0.03;
        reasons.push("low_risk");
      }
      if (input.permissionMode !== "full" && risk === "critical") {
        score -= 0.15;
        reasons.push("critical_risk_penalty");
      }

      return { skill, score, matchReasons: reasons };
    });

    await this.addSemanticScores(query, scored);
    scored.sort((a, b) => b.score - a.score);

    const limit = Math.max(1, Math.min(input.limit, enabled.length));
    const selected = scored.slice(0, limit);
    const fallbackUsed = selected.every((entry) => entry.score < 0.1);
    if (fallbackUsed) {
      for (const entry of selected) {
        entry.matchReasons.push("broad_fallback");
      }
    }

    return {
      tools: selected,
      topK: selected.length,
      fallbackUsed,
      topKReason: fallbackUsed
        ? "no confident match; broad safe catalog provided to the model"
        : "query and capability similarity",
    };
  }

  private async addSemanticScores(
    query: string,
    scored: Array<{
      skill: SkillSummary;
      score: number;
      matchReasons: string[];
    }>,
  ): Promise<void> {
    const embedding = this.deps.embeddingService;
    if (!embedding?.hasRealProvider || !query) return;

    try {
      const queryEmbedding =
        this.deps.skillEmbeddingCache?.getQueryEmbedding(query) ??
        await embedding.embed(query);
      this.deps.skillEmbeddingCache?.setQueryEmbedding(query, queryEmbedding);

      const values = await Promise.all(
        scored.map(async ({ skill }) => {
          const cached = this.deps.skillEmbeddingCache
            ? await this.deps.skillEmbeddingCache.getEmbedding(skill).catch(() => undefined)
            : undefined;
          return cached ?? embedding.embed(
            `${skill.name} — ${skill.description} — ${skill.category}`,
          ).catch(() => undefined);
        }),
      );

      if (!embedding.hasRealProvider) return;
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        const entry = scored[index];
        if (!value || !entry) continue;
        const similarity = cosineSimilarity(queryEmbedding, value);
        entry.score += Math.max(0, similarity) * 0.6;
        if (similarity >= 0.65) {
          entry.matchReasons.push(`semantic:${similarity.toFixed(2)}`);
        }
      }
    } catch {
      // Retrieval degradation is observable through fallbackUsed; it must not
      // turn into a semantic no-tool decision.
    }
  }
}

function tokenize(text: string): string[] {
  const latin = text
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const cjk = [...text.matchAll(/[\p{Script=Han}]{2,}/gu)]
    .flatMap((match) => {
      const value = match[0];
      const grams: string[] = [];
      for (let index = 0; index < value.length - 1; index++) {
        grams.push(value.slice(index, index + 2));
      }
      return grams;
    });
  return [...new Set([...latin, ...cjk])];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}
