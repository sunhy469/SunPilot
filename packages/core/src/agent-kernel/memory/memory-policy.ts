import type { MemoryQualityScore, MemoryRelationEntry } from "@sunpilot/protocol";
import type { MemoryPolicy, MemoryPolicyDecision } from "./memory-types.js";

/**
 * DefaultMemoryPolicy — decides whether to create, supersede, or reject a memory candidate.
 *
 * Enhanced with contradiction detection (§6 of architecture next steps):
 * - Detects when a new candidate contradicts existing memories
 * - Resolves contradictions by preferring user-explicit over model-inferred
 * - Computes quality scores for recall prioritization
 */
export class DefaultMemoryPolicy implements MemoryPolicy {
  classify(input: Parameters<MemoryPolicy["classify"]>[0]): MemoryPolicyDecision {
    const { candidate, secretScan, similar } = input;

    // ── Rejection rules ─────────────────────────────────────────────
    if (secretScan.hasSecrets) {
      return {
        action: "reject",
        reason: `contains secret-like content: ${secretScan.reasons.join(", ")}`,
      };
    }
    if (candidate.confidence < 0.45) {
      return {
        action: "reject",
        reason: "confidence below memory threshold",
      };
    }
    if (candidate.importance < 0.35) {
      return {
        action: "reject",
        reason: "importance below memory threshold",
      };
    }
    if (candidate.content.trim().length < 12) {
      return {
        action: "reject",
        reason: "content too short for long-term memory",
      };
    }

    // ── Contradiction detection ─────────────────────────────────────
    // Check if the new candidate contradicts any existing memory.
    // User-explicit memories take priority over model-inferred ones.
    const contradiction = detectContradiction(candidate, similar);
    if (contradiction) {
      // If the new candidate is user-explicit (higher confidence) and the
      // existing memory is model-inferred, supersede the old one.
      if (
        candidate.source === "user_explicit" &&
        contradiction.source !== "user_explicit"
      ) {
        return {
          action: "supersede",
          reason: `User-explicit memory supersedes contradictory ${contradiction.source} memory ${contradiction.id}: ${contradiction.reason}`,
          supersedeMemoryId: contradiction.id,
          contradiction: {
            existingId: contradiction.id,
            existingSource: contradiction.source,
            reason: contradiction.reason,
          },
        };
      }

      // If the existing memory is user-explicit and the new one is not,
      // reject the new candidate (user preference wins).
      if (
        contradiction.source === "user_explicit" &&
        candidate.source !== "user_explicit"
      ) {
        return {
          action: "reject",
          reason: `Contradicts user-explicit memory ${contradiction.id}: ${contradiction.reason}. User preference preserved.`,
        };
      }

      // Both are same source type — use confidence to decide.
      // Newer, higher-confidence info wins.
      if ((candidate.confidence ?? 0.5) > (contradiction.existingConfidence ?? 0.5)) {
        return {
          action: "supersede",
          reason: `Higher-confidence memory supersedes contradictory memory ${contradiction.id}: ${contradiction.reason}`,
          supersedeMemoryId: contradiction.id,
          contradiction: {
            existingId: contradiction.id,
            existingSource: contradiction.source,
            reason: contradiction.reason,
          },
        };
      }

      // Existing memory has higher or equal confidence — reject new.
      return {
        action: "reject",
        reason: `Contradicts higher-confidence existing memory ${contradiction.id}: ${contradiction.reason}`,
      };
    }

    // ── Supersede detection ─────────────────────────────────────────
    const supersede = similar.find(
      (memory) =>
        memory.type === candidate.type &&
        memory.scope === candidate.scope &&
        (memory.scopeId ?? "") === (candidate.scopeId ?? "") &&
        (memory.relevance >= 0.9 ||
          normalize(memory.title ?? memory.key) === normalize(candidate.title)),
    );
    if (supersede) {
      return {
        action: "supersede",
        reason: `supersedes similar memory ${supersede.id}`,
        supersedeMemoryId: supersede.id,
      };
    }

    return { action: "create", reason: candidate.reason };
  }

  /**
   * Compute a quality score for a memory candidate.
   *
   * Factors (§6):
   * - Source credibility (user_explicit > tool_evidence > model_inferred)
   * - Recency (newer = higher)
   * - User confirmation status
   * - Task relevance (from metadata)
   * - Tool evidence backing
   * - Conflict detection with existing memories
   */
  computeQualityScore(params: {
    candidate: {
      source: string;
      confidence: number;
      importance: number;
      metadata?: Record<string, unknown>;
    };
    hasConflicts: boolean;
    userConfirmed?: boolean;
    hasToolEvidence?: boolean;
  }): MemoryQualityScore {
    const { candidate, hasConflicts, userConfirmed, hasToolEvidence } = params;

    // Source credibility: user > tool > model
    const sourceCredibility =
      candidate.source === "user_explicit"
        ? 0.95
        : candidate.source === "agent_task_summary"
          ? 0.75
          : candidate.source === "memory_update_intent"
            ? 0.65
            : 0.55;

    // Recency: weighted by confidence
    const recency = Math.min(1.0, (candidate.confidence ?? 0.5) * 1.1);

    // Task relevance from metadata
    const taskRelevance = candidate.importance ?? 0.5;

    const score = Math.round(
      (sourceCredibility * 0.30 +
        recency * 0.20 +
        (userConfirmed ? 0.20 : 0.05) +
        taskRelevance * 0.15 +
        (hasToolEvidence ? 0.10 : 0.0) +
        (hasConflicts ? 0.0 : 0.05)) * 100,
    ) / 100;

    return {
      score: Math.min(1.0, score),
      sourceCredibility,
      recency,
      userConfirmed: userConfirmed ?? false,
      taskRelevance,
      toolEvidence: hasToolEvidence ?? false,
      hasConflicts,
      computedAt: new Date().toISOString(),
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Contradiction detection result — returned when a new candidate
 * semantically contradicts an existing memory.
 */
export interface ContradictionResult {
  /** ID of the existing memory that is contradicted. */
  id: string;
  /** Source of the existing memory. */
  source: string;
  /** Confidence of the existing memory. */
  existingConfidence?: number;
  /** Human-readable reason for the contradiction. */
  reason: string;
}

/**
 * Detects if a new memory candidate contradicts any existing memories.
 *
 * Contradiction signals:
 * - Same key/title with opposite polarity (e.g., "prefer X" vs "prefer Y")
 * - Same scope/type with conflicting content summaries
 * - User correction patterns ("no, actually...", "change that to...")
 */
function detectContradiction(
  candidate: {
    key: string;
    title: string;
    content: string;
    source: string;
    scope?: string;
    type?: string;
  },
  similar: Array<{
    id: string;
    key?: string;
    title?: string;
    content?: string;
    source?: string;
    scope?: string;
    type?: string;
    confidence?: number;
    relevance: number;
  }>,
): ContradictionResult | null {
  for (const existing of similar) {
    // Must be in the same scope and type
    if (
      existing.scope !== candidate.scope ||
      existing.type !== candidate.type
    ) {
      continue;
    }

    // Same key but different content — likely contradiction
    if (
      existing.key === candidate.key &&
      existing.relevance >= 0.7
    ) {
      const existingContent = (existing.content ?? "").toLowerCase();
      const candidateContent = candidate.content.toLowerCase();

      // Check for negation patterns (prefer X vs don't prefer X)
      const negationWords = [
        "don't",
        "do not",
        "not",
        "never",
        "no longer",
        "不再",
        "不",
        "别",
        "不要",
      ];
      const existingNegated = negationWords.some((w) =>
        existingContent.includes(w),
      );
      const candidateNegated = negationWords.some((w) =>
        candidateContent.includes(w),
      );

      if (existingNegated !== candidateNegated) {
        return {
          id: existing.id,
          source: existing.source ?? "unknown",
          existingConfidence: existing.confidence,
          reason: `Polarity contradiction: "${candidate.title}" conflicts with "${existing.title ?? existing.key}"`,
        };
      }

      // Content divergence: substantially different content for same key
      if (existing.relevance < 0.5 && existing.relevance >= 0.3) {
        return {
          id: existing.id,
          source: existing.source ?? "unknown",
          existingConfidence: existing.confidence,
          reason: `Content divergence: "${candidate.title}" has different content than "${existing.title ?? existing.key}"`,
        };
      }
    }

    // Correction patterns in the new content
    const correctionPatterns = [
      /\b(?:actually|no|更正|纠正|不对|应该是|change that to|update that to)\b/i,
      /\b(?:prefer|preference)\s+(?:is now|changed|updated)\b/i,
    ];
    const hasCorrection = correctionPatterns.some((p) =>
      p.test(candidate.content),
    );
    if (hasCorrection && existing.relevance >= 0.5) {
      return {
        id: existing.id,
        source: existing.source ?? "unknown",
        existingConfidence: existing.confidence,
        reason: `Correction pattern detected: new memory corrects or updates "${existing.title ?? existing.key}"`,
      };
    }
  }

  return null;
}
