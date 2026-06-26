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

    // ── §7.6: Dedup for same (scope, scopeId, type) with close confidence ──
    // Within a single run, consecutive tool turns produce near-identical
    // observations. Skip writing if an existing memory has the same scope,
    // scopeId, and type AND confidence within ±0.1 — it's a duplicate.
    const duplicate = similar.find(
      (memory) =>
        memory.type === candidate.type &&
        memory.scope === candidate.scope &&
        (memory.scopeId ?? "") === (candidate.scopeId ?? "") &&
        Math.abs((memory.confidence ?? 0.5) - (candidate.confidence ?? 0.5)) <= 0.1,
    );
    if (duplicate) {
      return {
        action: "reject",
        reason: `duplicate of existing memory ${duplicate.id} (same scope/type, confidence within ±0.1)`,
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

    // §B24: Recency should reflect how recently the memory was updated,
    // not its confidence. Derive from metadata.updatedAt (or timestamp)
    // and decay over a 30-day window: fresh → 1.0, 30+ days old → 0.
    // When updatedAt is unavailable, default to 1.0 (treat as fresh).
    const recency = computeRecency(candidate.metadata);

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
 * §B24: Compute a recency score in [0, 1] from a memory's updatedAt
 * timestamp. Fresh memories score 1.0; memories older than 30 days score
 * 0. When no timestamp is available, default to 1.0 (treat as fresh).
 */
function computeRecency(metadata?: Record<string, unknown>): number {
  if (!metadata) return 1.0;
  const raw = metadata.updatedAt ?? metadata.timestamp;
  if (typeof raw !== "string") return 1.0;
  const updated = new Date(raw);
  const ms = updated.getTime();
  if (Number.isNaN(ms)) return 1.0;
  const daysSinceUpdate = (Date.now() - ms) / (24 * 60 * 60 * 1000);
  return Math.max(0, 1 - daysSinceUpdate / 30);
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
      // §B25: Use multi-word phrases instead of bare "not" to avoid
      // false positives on words like "note", "nothing", "noted".
      const negationWords = [
        "don't",
        "doesn't",
        "do not",
        "does not",
        "no longer",
        "never",
        "不再",
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

      // Content divergence: substantially different content for same key.
      // §C5: This branch is inside the `existing.relevance >= 0.7` outer
      // guard, so the previous condition `relevance < 0.5 && relevance >= 0.3`
      // was always false (dead code). Treat "high but not extremely high"
      // relevance (0.7 ≤ relevance < 0.85) as a divergence signal instead.
      if (existing.relevance < 0.85) {
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
