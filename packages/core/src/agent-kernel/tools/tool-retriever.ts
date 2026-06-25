import type { SkillSummary } from "./tool-types.js";
import type { RoutedIntent } from "../loop-types.js";
import type { EmbeddingService } from "../context/embedding-service.js";
import type { SkillEmbeddingCache } from "./skill-embedding-cache.js";

// ── Retrieval Types ──────────────────────────────────────────────────────

export interface ToolRetrievalInput {
  /** Current user message or query. */
  query: string;
  /** Routed intent for capability-based filtering. */
  intent: RoutedIntent;
  /** All available skills. */
  availableSkills: SkillSummary[];
  /** Embedding service for semantic similarity (optional). */
  embeddingService?: EmbeddingService;
  /** §P1-2: Shared skill embedding cache (optional). */
  skillEmbeddingCache?: SkillEmbeddingCache;
  /** Recent tool call history for success/failure weighting. */
  recentHistory?: ToolCallHistoryEntry[];
  /** Current run's permission mode. */
  permissionMode?: "ask" | "auto" | "full";
}

export interface ToolCallHistoryEntry {
  skillId: string;
  status: "completed" | "failed" | "timeout" | "rejected";
  timestamp: string;
}

export interface ScoredTool {
  skill: SkillSummary;
  score: number;
  matchReasons: string[];
}

export interface ToolRetrievalResult {
  /** Scored and ranked tools. */
  tools: ScoredTool[];
  /** Requested Top-K count. */
  topK: number;
  /** Whether the retrieval fell back to a broader search. */
  fallbackUsed: boolean;
  /** Reason for the Top-K selection. */
  topKReason: string;
}

// ── Dynamic Top-K ────────────────────────────────────────────────────────

/**
 * Determine the optimal number of tools to present to the model based on
 * task complexity and intent (§4).
 *
 * Heuristic:
 * - casual_chat: 0 (no tools needed)
 * - simple tool action: 1–3
 * - multi-step task: 3–8
 * - ambiguous task: 0 (clarify first)
 */
export function computeDynamicTopK(
  intent: RoutedIntent,
  availableSkillCount: number,
  hasEmbeddingService: boolean,
): { topK: number; reason: string } {
  if (availableSkillCount === 0) {
    return { topK: 0, reason: "no tools available" };
  }

  switch (intent.type) {
    case "casual_chat":
      return { topK: 0, reason: "casual chat — no tools needed" };

    case "question_answering":
      return {
        topK: Math.min(1, availableSkillCount),
        reason: "question answering — minimal tools",
      };

    case "file_operation":
    case "shell_operation":
    case "code_generation":
    case "code_modification":
    case "memory_update":
      return {
        topK: Math.min(3, availableSkillCount),
        reason: `simple action (${intent.type}) — 1–3 tools`,
      };

    case "use_skill":
    case "artifact_generation":
    case "automation_execution":
      return {
        topK: Math.min(5, availableSkillCount),
        reason: `multi-step task (${intent.type}) — 3–5 tools`,
      };

    case "project_analysis":
      return {
        topK: Math.min(8, availableSkillCount),
        reason: `complex analysis (${intent.type}) — up to 8 tools`,
      };

    case "unknown":
    default:
      if (intent.confidence < 0.5) {
        return {
          topK: 0,
          reason: "ambiguous intent — clarify before tool selection",
        };
      }
      return {
        topK: Math.min(3, availableSkillCount),
        reason: "unknown intent with moderate confidence — 1–3 tools",
      };
  }
}

// ── Coarse Retrieval ─────────────────────────────────────────────────────

/**
 * ToolRetriever — multi-layer tool retrieval pipeline (§4).
 *
 * Layers:
 * 1. Keyword match (fast, deterministic)
 * 2. Capability/category match (intent-aware)
 * 3. Permission/risk match (safety-aware)
 * 4. Embedding similarity (semantic, optional)
 * 5. Recent success/failure history boost
 *
 * After scoring, applies dynamic Top-K to return only the most relevant tools.
 */
export class ToolRetriever {
  /**
   * Retrieve and score tools based on the current context.
   */
  async retrieve(input: ToolRetrievalInput): Promise<ToolRetrievalResult> {
    const { query, intent, availableSkills, embeddingService, skillEmbeddingCache, recentHistory, permissionMode } = input;

    if (availableSkills.length === 0) {
      return {
        tools: [],
        topK: 0,
        fallbackUsed: false,
        topKReason: "no tools available",
      };
    }

    // ── Layer 1: Keyword match ─────────────────────────────────────
    const queryLower = query.toLowerCase();
    const queryTokens = tokenize(queryLower);

    const scored: ScoredTool[] = availableSkills.map((skill) => {
      const reasons: string[] = [];
      let score = 0;

      // Name match
      const nameLower = skill.name.toLowerCase();
      const descLower = skill.description.toLowerCase();

      // Exact name match
      if (nameLower.includes(queryLower) || queryLower.includes(nameLower)) {
        score += 0.4;
        reasons.push("name_match");
      }

      // Keyword overlap
      const nameTokens = tokenize(nameLower);
      const descTokens = tokenize(descLower);
      const nameOverlap = queryTokens.filter((t) => nameTokens.includes(t));
      const descOverlap = queryTokens.filter((t) => descTokens.includes(t));
      const keywordScore =
        (nameOverlap.length / Math.max(1, queryTokens.length)) * 0.3 +
        (descOverlap.length / Math.max(1, queryTokens.length)) * 0.15;
      score += keywordScore;

      if (nameOverlap.length > 0) reasons.push(`name_keyword:${nameOverlap.join(",")}`);
      if (descOverlap.length > 0) reasons.push(`desc_keyword:${descOverlap.join(",")}`);

      return { skill, score, matchReasons: reasons };
    });

    // ── Layer 2: Capability/category match ─────────────────────────
    for (const entry of scored) {
      const skill = entry.skill;

      // Intent-to-skill mapping
      if (
        intent.candidateSkills?.includes(skill.id) ||
        intent.candidateSkills?.some((cs) =>
          skill.id.includes(cs) || cs.includes(skill.id),
        )
      ) {
        entry.score += 0.25;
        entry.matchReasons.push("intent_candidate");
      }

      // Category relevance
      const categoryRelevance = getCategoryRelevance(intent.type, skill.category ?? "general");
      entry.score += categoryRelevance * 0.15;
      if (categoryRelevance > 0.5) {
        entry.matchReasons.push(`category:${skill.category}`);
      }
    }

    // ── Layer 3: Permission/risk match ────────────────────────────
    if (permissionMode) {
      for (const entry of scored) {
        const riskLevel = entry.skill.riskHints?.defaultRisk ?? "low";
        const mode: string = permissionMode;

        if (mode === "full") {
          // Full permission — all skills allowed
          entry.score += 0.05;
        } else if (mode === "auto" && riskLevel !== "critical") {
          entry.score += 0.05;
          entry.matchReasons.push("auto_permitted");
        } else if (mode === "ask" && riskLevel === "low") {
          entry.score += 0.05;
          entry.matchReasons.push("low_risk_preferred");
        }

        if (riskLevel === "critical" && mode !== "full") {
          // Critical risk tools penalized when not in full mode
          entry.score -= 0.2;
          entry.matchReasons.push("critical_risk_penalized");
        }
      }
    }

    // ── Layer 4: Embedding similarity (optional) ──────────────────
    // Only used when a REAL embedding provider is active AND has not
    // degraded to fallback. The door check (hasRealProvider) covers
    // pre-existing degradation; the post-query check catches provider
    // failure DURING the query embed call (mid-call degradation).
    // §P1-2: Batch-parallelize skill embedding calls to avoid sequential
    // await-per-skill latency. Uses same concurrency limit as IntentRouter.
    if (embeddingService && embeddingService.hasRealProvider) {
      try {
        const queryEmbedding = await embeddingService.embed(query);

        // Re-check after query embed: the provider may have failed
        // during this call and fallen back to lexical hash. If it did,
        // the query vector is NOT semantic — skip scoring entirely
        // rather than mixing real skill vectors with a fallback query.
        if (!embeddingService.hasRealProvider) {
          // Degraded mid-call — skip embedding scoring
        } else {
          // §P1-2: Batch-parallelize with shared cache — process in groups of 8.
          // Uses SkillEmbeddingCache when available to avoid duplicate API calls
          // with IntentRouter. Was sequential await per skill.
          const MAX_CONCURRENCY = 8;
          const embeddings: Array<{ index: number; embedding: number[] | undefined }> = [];
          for (let i = 0; i < scored.length; i += MAX_CONCURRENCY) {
            const batch = scored.slice(i, i + MAX_CONCURRENCY);
            const batchResults = await Promise.allSettled(
              batch.map(async (entry, bi) => {
                const skill = entry.skill;
                const descEmbedding = skillEmbeddingCache
                  ? (await skillEmbeddingCache.getEmbedding(skill).catch(() => undefined))
                    ?? await embeddingService!.embed(`${skill.name} — ${skill.description} — category: ${skill.category}`).catch(() => undefined)
                  : await embeddingService!.embed(`${skill.name} — ${skill.description} — category: ${skill.category}`).catch(() => undefined);
                return { index: i + bi, embedding: descEmbedding };
              }),
            );
            for (const br of batchResults) {
              if (br.status === "fulfilled") {
                embeddings.push(br.value);
              }
            }
          }

          // Apply similarity scores from batch results
          if (embeddingService.hasRealProvider) {
            for (const { index, embedding: descEmbedding } of embeddings) {
              if (!descEmbedding) continue;
              const entry = scored[index];
              if (!entry) continue;
              const similarity = cosineSimilarity(queryEmbedding, descEmbedding);
              // 0.5 weight — embedding is the PRIMARY scoring signal;
              // keyword/bigram are tiebreakers only.
              entry.score += similarity * 0.5;
              if (similarity > 0.7) {
                entry.matchReasons.push(`semantic:${similarity.toFixed(2)}`);
              }
            }
          }
        }
      } catch {
        // Embedding failed — continue without semantic scoring
      }
    }

    // ── Layer 5: History boost ────────────────────────────────────
    if (recentHistory && recentHistory.length > 0) {
      for (const entry of scored) {
        const historyEntries = recentHistory.filter(
          (h) => h.skillId === entry.skill.id,
        );
        if (historyEntries.length > 0) {
          const successRate =
            historyEntries.filter((h) => h.status === "completed").length /
            historyEntries.length;
          // Boost recently successful tools, penalize recently failed
          entry.score += (successRate - 0.5) * 0.1;
          if (successRate === 1.0) {
            entry.matchReasons.push("history_all_success");
          } else if (successRate === 0) {
            entry.matchReasons.push("history_all_failed");
          }
        }
      }
    }

    // ── Sort by score ─────────────────────────────────────────────
    scored.sort((a, b) => b.score - a.score);

    // ── Dynamic Top-K ─────────────────────────────────────────────
    const hasEmbedding = !!embeddingService;
    const { topK, reason: topKReason } = computeDynamicTopK(
      intent,
      availableSkills.length,
      hasEmbedding,
    );

    const truncated = scored.slice(0, Math.min(topK, scored.length));

    // Determine if we used fallback (no tools matched well)
    const fallbackUsed =
      truncated.length === 0 ||
      (truncated.length > 0 && truncated[0]!.score < 0.1);

    return {
      tools: truncated,
      topK,
      fallbackUsed,
      topKReason,
    };
  }

  /**
   * Synchronous coarse retrieval — fast keyword + category pre-filter.
   * Used when we don't need full scoring (e.g., intent routing has already
   * identified candidate skills).
   */
  coarseFilter(
    query: string,
    skills: SkillSummary[],
    intent: RoutedIntent,
    maxResults = 10,
  ): SkillSummary[] {
    const queryLower = query.toLowerCase();
    const queryTokens = tokenize(queryLower);

    const scored = skills.map((skill) => {
      let score = 0;
      const nameLower = skill.name.toLowerCase();
      const descLower = skill.description.toLowerCase();

      if (nameLower.includes(queryLower) || queryLower.includes(nameLower)) {
        score += 3;
      }

      const nameOverlap = tokenize(nameLower).filter((t) =>
        queryTokens.includes(t),
      ).length;
      const descOverlap = tokenize(descLower).filter((t) =>
        queryTokens.includes(t),
      ).length;
      score += nameOverlap * 2 + descOverlap;

      if (intent.candidateSkills?.includes(skill.id)) {
        score += 3;
      }

      return { skill, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored
      .filter((s) => s.score > 0)
      .slice(0, maxResults)
      .map((s) => s.skill);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  // Simple tokenizer: split on non-alphanumeric, filter short tokens
  return text
    .split(/[\s,.;:!?，。；：！？、]+/)
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 2);
}

function getCategoryRelevance(
  intentType: RoutedIntent["type"],
  skillCategory: string,
): number {
  const relevanceMap: Record<string, string[]> = {
    file_operation: ["filesystem"],
    shell_operation: ["shell"],
    code_generation: ["code", "file"],
    code_modification: ["code", "file"],
    artifact_generation: ["artifact", "code"],
    use_skill: ["web", "data", "search", "product"],
    memory_update: ["memory"],
    project_analysis: ["analysis", "search", "code", "web"],
    automation_execution: ["automation", "shell"],
    question_answering: ["search", "web", "knowledge"],
  };

  const relevantCategories = relevanceMap[intentType] ?? [];
  return relevantCategories.includes(skillCategory) ? 1.0 : 0.2;
}

function cosineSimilarity(a: number[], b: number[]): number {
  // §B4: dimension mismatch usually means comparing embeddings from
  // different models / providers — silently truncating would produce a
  // meaningless score. Fail closed (0) and log so the operator can fix the
  // configuration.
  if (a.length !== b.length) {
    console.warn(
      `[tool-retriever] cosineSimilarity dimension mismatch: ${a.length} vs ${b.length}; returning 0`,
    );
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
