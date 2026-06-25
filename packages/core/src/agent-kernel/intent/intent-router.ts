import type { LlmProvider } from "../../llm/llm.provider.js";
import type { EmbeddingService } from "../context/embedding-service.js";
import type {
  AgentContext,
  IntentRouter as IntentRouterInterface,
  RoutedIntent,
} from "../loop-types.js";
import { DEFAULT_INTENT_RULES, type IntentRule } from "./intent-types.js";
import type { SkillEmbeddingCache } from "../tools/skill-embedding-cache.js";

export interface IntentRouterDeps {
  /**
   * Optional light model for intent classification.
   * Used as Layer 2 fallback when embedding confidence is insufficient.
   */
  llm?: LlmProvider;
  /**
   * Optional embedding service for semantic skill matching (Layer 1).
   * When provided, user queries are matched against skill descriptions
   * via cosine similarity BEFORE the LLM is called.
   */
  embeddingService?: EmbeddingService;
  /**
   * §P1-2: Shared skill embedding cache. When provided, skill embeddings
   * are read from cache instead of recomputed per turn. Pre-warm at
   * startup for best performance.
   */
  skillEmbeddingCache?: SkillEmbeddingCache;
  /** Custom intent rules to prepend before defaults. */
  rules?: IntentRule[];
}

/**
 * IntentRouter — user intent classifier with 4-layer confidence-gated cascade:
 *
 * Layer 0: Form-match rules (fastest, <1ms)
 *   - Exact slash commands (^\/[a-z]) and short formulaic greetings
 *   - Only matches STRUCTURE/FORM, never semantic meaning
 *   - Short-circuits immediately on match
 *
 * Layer 1: Embedding semantic matching (~50-200ms)
 *   - Embeds user query and computes cosine similarity against skill
 *     name+description embeddings
 *   - Short-circuits ONLY at ≥0.95 confidence (extremely clear matches)
 *   - Below threshold, generates Top-5 hints for Layer 2 LLM classification
 *   - Short-circuit rate: ~5% (was higher before responsibility convergence)
 *
 * Layer 2: LLM classification (~200-500ms)
 *   - Lightweight model classifies intent AND selects specific skill
 *   - Only invoked when embedding confidence is insufficient
 *   - Handles ~15% of ambiguous or complex requests
 *
 * Layer 3: Default 'unknown' (instant)
 *   - Confidence 0.3, no tools — falls through to pure LLM response
 *
 * Architecture doc §10.3 (revised): form-match → embedding → LLM → default
 */
export class IntentRouter implements IntentRouterInterface {
  private readonly rules: IntentRule[];

  constructor(private readonly deps: IntentRouterDeps = {}) {
    this.rules = [...(deps.rules ?? []), ...DEFAULT_INTENT_RULES];
  }

  async route(
    context: AgentContext,
    _signal: AbortSignal,
  ): Promise<RoutedIntent> {
    const message = context.currentMessage.content.trim();

    // ── Layer 0: Form-match rules (slash commands + formulaic) ──────
    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        if (pattern.test(message)) {
          return {
            type: rule.type,
            confidence: rule.type === "casual_chat" ? 0.9 : 0.85,
            requiresPlanning: rule.requiresPlanning,
            requiresTool: rule.requiresTool,
            requiresApproval: rule.requiresApproval,
            riskLevel: rule.riskLevel,
            candidateSkills: rule.candidateSkills,
            reason: `Form-match: ${pattern.source}`,
            trace: { formMatch: true },
          };
        }
      }
    }

    // ── Layer 1: Embedding semantic skill matching ──────────────────
    // Only allowed to short-circuit when a REAL embedding provider is
    // active. Fallback (keyword/hash) embeddings are NOT semantic and
    // should only provide hints to the LLM layer, never skip it.
    let embeddingHints: RoutedIntent | null = null;
    if (
      this.deps.embeddingService &&
      context.availableSkills &&
      context.availableSkills.length > 0
    ) {
      try {
        const embeddingResult = await this.matchSkillWithEmbedding(context);
        if (embeddingResult) {
          // P0 fix: only short-circuit when real embeddings are available.
          // Fallback (keyword/hash) vectors express lexical overlap, not
          // semantic similarity — they cannot be trusted to skip the LLM.
          // hasRealProvider now accounts for runtime degradation: if the
          // provider API failed and the service fell back to keyword/hash,
          // hasRealProvider returns false — we won't short-circuit on
          // lexical scores.
          const isRealEmbedding = this.deps.embeddingService.hasRealProvider;
          // Only short-circuit at ≥0.95 confidence (tightened from 0.85).
          // The LLM layer always runs for intermediate-confidence cases.
          if (isRealEmbedding && embeddingResult.confidence >= 0.95) {
            return embeddingResult;
          }
          // Save hints for Layer 2 even when below threshold or in fallback mode
          embeddingHints = embeddingResult;
        }
      } catch {
        // Embedding failed — fall through to LLM
      }
    }

    // ── Layer 2: LLM classification + skill selection ───────────────
    if (this.deps.llm) {
      try {
        const intent = await this.classifyWithLlm(context, embeddingHints);
        if (intent) return intent;
      } catch {
        // LLM unavailable — fall through to default
      }
    }

    // ── Layer 3: Default 'unknown' intent ───────────────────────────
    return {
      type: "unknown",
      confidence: 0.3,
      requiresPlanning: false,
      requiresTool: false,
      requiresApproval: false,
      riskLevel: "low",
      candidateSkills: [],
      reason: "No form-match, embedding, or LLM match — defaulting to unknown",
    };
  }

  /**
   * Layer 1 — Embedding-based semantic skill matching.
   *
   * Embeds the user query as a single vector, then embeds each skill's
   * "name — description" text and computes cosine similarity. Returns
   * the best match with confidence = similarity score.
   *
   * Short-circuits ONLY when ALL of these hold (extremely confident):
   *   - Real embedding provider is active (not fallback)
   *   - similarity ≥ 0.95 (very high semantic match)
   *   - gap between best and runner-up > 0.3 (clear winner)
   *
   * Below these thresholds, returns hints for the LLM layer instead.
   *
   * Responsibility boundary (§P1): IntentRouter provides intent + hints;
   * ToolRetriever/ToolDecisionEngine makes the final tool selection.
   */
  private async matchSkillWithEmbedding(
    context: AgentContext,
  ): Promise<RoutedIntent | null> {
    const embeddingService = this.deps.embeddingService!;
    const skills = context.availableSkills;

    if (skills.length === 0) return null;

    const message = context.currentMessage.content;

    // Embed user query once
    const queryEmbedding = await embeddingService.embed(message);

    // Embed each skill using rich text: name + description + category.
    // Category adds semantic context (e.g. "web" vs "filesystem") that
    // helps distinguish tools with similar names in different domains.
    // Parallelized with concurrency limit to avoid overwhelming the
    // embedding service (local or remote rate-limited APIs).
    // §P1-2: Use shared cache when available to avoid duplicate embeddings.
    const MAX_EMBEDDING_CONCURRENCY = 8;
    const scored: Array<{ skillId: string; similarity: number }> = [];
    const cache = this.deps.skillEmbeddingCache;

    // Process skills in batches to limit concurrency
    for (let i = 0; i < skills.length; i += MAX_EMBEDDING_CONCURRENCY) {
      const batch = skills.slice(i, i + MAX_EMBEDDING_CONCURRENCY);
      const batchResults = await Promise.allSettled(
        batch.map(async (skill) => {
          // §P1-2: Try cache first, fall back to embedding service
          const skillEmbedding = cache
            ? (await cache.getEmbedding(skill)) ?? await embeddingService.embed(`${skill.name} — ${skill.description} — category: ${skill.category}`)
            : await embeddingService.embed(`${skill.name} — ${skill.description} — category: ${skill.category}`);
          const similarity = cosineSimilarity(queryEmbedding, skillEmbedding);
          return { skillId: skill.id, similarity };
        }),
      );
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          scored.push(result.value);
        }
      }
    }

    if (scored.length === 0) return null;

    // Sort by similarity descending
    scored.sort((a, b) => b.similarity - a.similarity);

    const best = scored[0]!;
    const runnerUp = scored.length > 1 ? scored[1]! : { similarity: 0 };

    // High-confidence gate: similarity ≥ 0.95 AND gap > 0.3.
    // Tightened from 0.85/0.2 per architecture review — IntentRouter
    // should only short-circuit in extremely clear cases. The primary
    // tool selection authority is ToolRetriever/ToolDecisionEngine.
    if (best.similarity >= 0.95 && (best.similarity - runnerUp.similarity) > 0.3) {
      return {
        type: "use_skill",
        confidence: best.similarity,
        requiresPlanning: false,
        requiresTool: true,
        requiresApproval: false,
        riskLevel: "medium",
        candidateSkills: [best.skillId],
        reason: `Embedding short-circuit: "${best.skillId}" (sim=${best.similarity.toFixed(3)}, gap=${(best.similarity - runnerUp.similarity).toFixed(3)})`,
        trace: {
          embeddingMode: this.deps.embeddingService?.hasRealProvider
            ? "real"
            : this.deps.embeddingService?.isDegraded
              ? "degraded"
              : "lexical_fallback",
          embeddingTopScore: best.similarity,
          embeddingCandidateCount: skills.length,
        },
      };
    }

    // Below threshold — return null so Layer 2 (LLM) takes over.
    // We still return the embedding result but with low confidence
    // so callers can use candidate skills as hints for the LLM.
    if (best.similarity >= 0.5) {
      return {
        type: "use_skill",
        confidence: best.similarity,
        requiresPlanning: false,
        requiresTool: true,
        requiresApproval: false,
        riskLevel: "medium",
        candidateSkills: scored
          .slice(0, 5)
          .map((s) => s.skillId),
        reason: `Embedding hints (top sim=${best.similarity.toFixed(3)} < 0.95) — escalate to LLM`,
        trace: {
          embeddingMode: this.deps.embeddingService?.hasRealProvider
            ? "real"
            : this.deps.embeddingService?.isDegraded
              ? "degraded"
              : "lexical_fallback",
          embeddingTopScore: best.similarity,
          embeddingCandidateCount: skills.length,
        },
      };
    }

    return null;
  }

  /**
   * Layer 2 — LLM intent classification with optional embedding hints.
   *
   * When embedding hints are available (from Layer 1), they are presented
   * as "Suggested candidates" alongside the full skill catalog. The LLM
   * can select from the hints OR pick any other skill from the catalog,
   * OR return a non-tool intent (e.g. question_answering).
   *
   * @param context  Agent context with available skills
   * @param embeddingHints  Optional Top-5 hints from Layer 1 embedding,
   *   included even when confidence was too low to short-circuit
   */
  private async classifyWithLlm(
    context: AgentContext,
    embeddingHints?: RoutedIntent | null,
  ): Promise<RoutedIntent | null> {
    if (!this.deps.llm) return null;

    const message = context.currentMessage.content;
    const skillList = context.availableSkills
      .map((s) => `- ${s.id}: ${s.name} — ${s.description}`)
      .join("\n");

    // Build embedding hints section when available
    let hintsSection = "";
    const hintIds = embeddingHints?.candidateSkills?.length
      ? embeddingHints.candidateSkills
      : [];
    if (hintIds.length > 0) {
      const hintDetails = hintIds
        .map((id) => {
          const skill = context.availableSkills.find((s) => s.id === id);
          return skill
            ? `- ${skill.id}: ${skill.name} — ${skill.description}`
            : `- ${id}`;
        })
        .join("\n");
      const hintSource =
        this.deps.embeddingService?.hasRealProvider
          ? "semantic embedding (real)"
          : "lexical embedding (fallback — treat as weak signal)";
      hintsSection = `Suggested candidates (from ${hintSource}, similarity ${(embeddingHints?.confidence ?? 0).toFixed(3)}):
${hintDetails}

`;
    }

    const prompt = `Full skill catalog:
${skillList || "(none)"}

${hintsSection}Classify the user's intent into EXACTLY ONE of these categories:
- casual_chat: greetings, small talk, thanks
- question_answering: asking for information or explanation
- project_analysis: reviewing or analyzing code/project structure
- code_generation: writing new code, functions, or components
- code_modification: fixing, refactoring, or editing existing code
- file_operation: reading, writing, or managing files
- shell_operation: running commands, builds, or tests
- automation_execution: running an automated multi-step task
- artifact_generation: generating documents or reports
- memory_update: saving or updating preferences/facts
- diagnostics: debugging or troubleshooting
- use_skill: user wants to use a specific available skill listed above

If the suggested candidates are present and relevant, prefer them. But if they are wrong (e.g. a product-search tool suggested for a travel query), IGNORE them and pick the correct category.
If you choose use_skill, also specify WHICH skill ID from the list above.
Respond in this exact format:
  For use_skill: "use_skill:<skill-id>"  (e.g. "use_skill:jaderoad:product.source.search1688")
  For all others: just the category name  (e.g. "question_answering")

User message: "${message}"
`;
    const messages = [{ role: "user" as const, content: prompt }];
    let response = "";

    for await (const chunk of this.deps.llm.streamChat({ messages })) {
      response += chunk.delta;
    }

    const normalized = response.trim().toLowerCase();

    // Parse "use_skill:<skill-id>" format
    if (normalized.startsWith("use_skill:")) {
      const skillId = normalized.slice("use_skill:".length).trim();
      // §B18: validate the LLM-selected skillId actually exists in the
      // catalog. LLMs occasionally hallucinate skill IDs (or trim suffixes);
      // accept the parsed ID only when it matches an available skill.
      // Otherwise fall through to Layer 3 unknown rather than emitting an
      // intent that points at a non-existent skill. Comparison is
      // case-insensitive because the LLM response is already lowercased.
      const matched = context.availableSkills.find(
        (s) => s.id.toLowerCase() === skillId,
      );
      if (!skillId || !matched) {
        console.warn(
          `[intent-router] LLM returned use_skill:${skillId || "(empty)"} but no such skill exists; falling back to Layer 3`,
        );
        return null;
      }
      // Use the canonical ID from the catalog, not the LLM-cased variant.
      return this.defaultsForType("use_skill", matched.id);
    }

    const validTypes = [
      "casual_chat",
      "question_answering",
      "project_analysis",
      "code_generation",
      "code_modification",
      "file_operation",
      "shell_operation",
      "automation_execution",
      "artifact_generation",
      "memory_update",
      "diagnostics",
      "use_skill",
    ];

    if (validTypes.includes(normalized)) {
      return this.defaultsForType(normalized as RoutedIntent["type"]);
    }

    return null;
  }

  private defaultsForType(
    type: RoutedIntent["type"],
    selectedSkillId?: string,
  ): RoutedIntent {
    switch (type) {
      case "casual_chat":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: false,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [],
          reason: "LLM classified as casual chat",
        };
      case "question_answering":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: false,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [],
          reason: "LLM classified as question answering",
        };
      case "code_generation":
      case "code_modification":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: true,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: ["filesystem.read", "filesystem.write"],
          reason: `LLM classified as ${type}`,
        };
      case "file_operation":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: ["filesystem.read", "filesystem.write"],
          reason: "LLM classified as file operation",
        };
      case "shell_operation":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: true,
          riskLevel: "high",
          candidateSkills: ["shell.execute"],
          reason: "LLM classified as shell operation",
        };
      case "automation_execution":
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: [],
          reason: "LLM classified as automation execution",
        };
      case "use_skill":
        return {
          type,
          confidence: selectedSkillId ? 0.8 : 0.7,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: selectedSkillId ? [selectedSkillId] : [],
          reason: selectedSkillId
            ? `LLM selected skill: ${selectedSkillId}`
            : "LLM classified as skill usage",
        };
      default:
        return {
          type,
          confidence: 0.7,
          requiresPlanning: false,
          requiresTool: false,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [],
          reason: `LLM classified as ${type}`,
        };
    }
  }
}

/**
 * Cosine similarity between two vectors.
 * Returns a value in [0, 1] where 1 means identical direction.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  // §B4: dimension mismatch usually means comparing embeddings from
  // different models / providers — silently truncating would produce a
  // meaningless score. Fail closed (0) and log so the operator can fix the
  // configuration.
  if (a.length !== b.length) {
    console.warn(
      `[intent-router] cosineSimilarity dimension mismatch: ${a.length} vs ${b.length}; returning 0`,
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
