import { describe, expect, test } from "vitest";
import { DefaultMemoryPolicy } from "./memory-policy.js";
import type { MemoryCandidate, SecretScanResult } from "./memory-types.js";
import type { RetrievedMemoryRecord } from "@sunpilot/protocol";

function makeCandidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    key: "user_preference:answer-language",
    title: "Prefer concise answers",
    content: "User prefers concise answers in English.",
    type: "user_preference",
    scope: "user",
    scopeId: "user_1",
    source: "user_explicit",
    confidence: 0.92,
    importance: 0.6,
    reason: "User explicitly said 'remember'",
    ...overrides,
  };
}

function cleanScan(): SecretScanResult {
  return { hasSecrets: false, redactedText: "", reasons: [] };
}

function secretScan(): SecretScanResult {
  return { hasSecrets: true, redactedText: "[REDACTED:api_key]", reasons: ["api_key"] };
}

function makeSimilar(
  id: string,
  overrides: Partial<{
    type: string;
    scope: string;
    scopeId: string;
    title: string;
    key: string;
    content: string;
    source: string;
    confidence: number;
    relevance: number;
  }> = {},
): RetrievedMemoryRecord {
  return {
    id,
    score: 0.8,
    relevance: overrides.relevance ?? 0.85,
    key: overrides.key ?? "user_preference:answer-language",
    value: `value_${id}`,
    scope: overrides.scope ?? "user",
    scopeId: overrides.scopeId ?? "user_1",
    type: overrides.type ?? "user_preference",
    title: overrides.title ?? "Prefer concise answers",
    content: overrides.content ?? "User prefers concise answers in English.",
    source: overrides.source ?? "agent_task_summary",
    confidence: overrides.confidence ?? 0.75,
    importance: 0.6,
    metadata: {},
    createdAt: "2026-06-24T00:00:00.000Z",
  };
}

describe("DefaultMemoryPolicy", () => {
  const policy = new DefaultMemoryPolicy();

  describe("classify — create", () => {
    test("creates memory when no similar existing", () => {
      const result = policy.classify({
        candidate: makeCandidate(),
        secretScan: cleanScan(),
        similar: [],
      });
      expect(result.action).toBe("create");
    });

    test("creates memory when similar memories have different type/scope", () => {
      const result = policy.classify({
        candidate: makeCandidate(),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("other", { type: "deployment_info", scope: "project", scopeId: "p2" }),
        ],
      });
      expect(result.action).toBe("create");
    });
  });

  describe("classify — reject", () => {
    test("rejects when secrets found", () => {
      const result = policy.classify({
        candidate: makeCandidate(),
        secretScan: secretScan(),
        similar: [],
      });
      expect(result.action).toBe("reject");
      expect(result.reason).toContain("secret-like");
    });

    test("rejects when confidence below 0.45", () => {
      const result = policy.classify({
        candidate: makeCandidate({ confidence: 0.3 }),
        secretScan: cleanScan(),
        similar: [],
      });
      expect(result.action).toBe("reject");
      expect(result.reason).toContain("confidence");
    });

    test("rejects when importance below 0.35", () => {
      const result = policy.classify({
        candidate: makeCandidate({ importance: 0.2 }),
        secretScan: cleanScan(),
        similar: [],
      });
      expect(result.action).toBe("reject");
      expect(result.reason).toContain("importance");
    });

    test("rejects when content too short (< 12 chars)", () => {
      const result = policy.classify({
        candidate: makeCandidate({ content: "Too short" }),
        secretScan: cleanScan(),
        similar: [],
      });
      expect(result.action).toBe("reject");
      expect(result.reason).toContain("too short");
    });

    test("rejects content with only whitespace", () => {
      const result = policy.classify({
        candidate: makeCandidate({ content: "   \n   " }),
        secretScan: cleanScan(),
        similar: [],
      });
      expect(result.action).toBe("reject");
      expect(result.reason).toContain("too short");
    });
  });

  describe("classify — supersede (similar)", () => {
    test("supersedes when same type/scope/scopeId with high relevance", () => {
      const result = policy.classify({
        candidate: makeCandidate(),
        secretScan: cleanScan(),
        similar: [makeSimilar("old", { relevance: 0.95 })],
      });
      expect(result.action).toBe("supersede");
      expect(result.supersedeMemoryId).toBe("old");
    });

    test("supersedes when normalized title matches", () => {
      const result = policy.classify({
        candidate: makeCandidate({ title: "I Prefer Concise Answers" }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", { title: "i prefer concise answers", relevance: 0.7 }),
        ],
      });
      expect(result.action).toBe("supersede");
      expect(result.supersedeMemoryId).toBe("old");
    });

    test("does not supersede when relevance below 0.9 and title differs", () => {
      const result = policy.classify({
        candidate: makeCandidate({ title: "Prefer verbose answers" }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", { title: "Prefer concise answers", relevance: 0.6 }),
        ],
      });
      expect(result.action).toBe("create");
    });
  });

  describe("classify — contradiction: user-explicit wins", () => {
    test("user-explicit supersedes contradictory model-inferred memory", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          source: "user_explicit",
          content: "User prefers Chinese answers, not English.",
          key: "user_preference:answer-language",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            source: "agent_task_summary",
            content: "User prefers English answers.",
            key: "user_preference:answer-language",
            relevance: 0.75,
          }),
        ],
      });
      expect(result.action).toBe("supersede");
      expect(result.contradiction).toBeDefined();
    });

    test("rejects model-inferred when contradicts user-explicit", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          source: "agent_task_summary",
          content: "User does not want concise answers.",
          key: "user_preference:answer-language",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            source: "user_explicit",
            content: "User prefers concise answers.",
            key: "user_preference:answer-language",
            relevance: 0.75,
          }),
        ],
      });
      // "does not" is in negation list → polarity contradiction → user_explicit wins → reject
      expect(result.action).toBe("reject");
      expect(result.reason).toContain("User preference preserved");
    });

    test("higher confidence wins when same source type", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          source: "memory_update_intent",
          confidence: 0.9,
          content: "User does not want concise answers anymore.",
          key: "user_preference:answer-language",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            source: "memory_update_intent",
            confidence: 0.6,
            content: "User prefers concise answers.",
            key: "user_preference:answer-language",
            relevance: 0.75,
          }),
        ],
      });
      expect(result.action).toBe("supersede");
    });

    test("rejects when existing has higher or equal confidence in same source", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          source: "memory_update_intent",
          confidence: 0.5,
          content: "User does not want concise answers anymore.",
          key: "user_preference:answer-language",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            source: "memory_update_intent",
            confidence: 0.8,
            content: "User prefers concise answers.",
            key: "user_preference:answer-language",
            relevance: 0.75,
          }),
        ],
      });
      expect(result.action).toBe("reject");
      expect(result.reason).toContain("higher-confidence");
    });
  });

  describe("classify — contradiction: negation detection", () => {
    test("detects negation polarity contradiction", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          content: "User prefers Chinese answers, don't use English.",
          key: "user_preference:answer-language",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            content: "User prefers English answers.",
            key: "user_preference:answer-language",
            relevance: 0.8,
          }),
        ],
      });
      // Candidate has "don't", existing doesn't → polarity mismatch → contradiction
      expect(result.action === "supersede" || result.action === "reject").toBe(true);
    });

    test("detects content divergence at low relevance range", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          content: "User prefers Chinese answers for all communication.",
          key: "user_preference:answer-language",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            content: "User prefers concise English with bullet points.",
            key: "user_preference:answer-language",
            relevance: 0.4,
          }),
        ],
      });
      // Content divergence at relevance 0.3-0.5 → contradiction
      expect(result.action === "supersede" || result.action === "reject").toBe(true);
    });

    test("detects correction pattern: actually", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          content: "Actually, no. The user prefers Chinese answers.",
          key: "user_preference:new-pref",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            key: "user_preference:answer-language",
            title: "Answer language preference",
            content: "User prefers English.",
            relevance: 0.6,
          }),
        ],
      });
      // Correction pattern "actually" detected → contradiction
      expect(result.action === "supersede" || result.action === "reject").toBe(true);
      expect(result.contradiction).toBeDefined();
    });

    test("detects correction pattern: change that to", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          content: "Change that to Chinese — user prefers Chinese answers.",
          key: "user_preference:new-pref",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            key: "user_preference:answer-language",
            title: "Answer language",
            relevance: 0.6,
          }),
        ],
      });
      // "Change that to" matches correction pattern → contradiction
      expect(result.action === "supersede" || result.action === "reject").toBe(true);
      expect(result.contradiction).toBeDefined();
    });

    test("no contradiction when scopes differ", () => {
      const result = policy.classify({
        candidate: makeCandidate({
          content: "Change: project uses Rust.",
          scope: "project",
          scopeId: "p123",
          type: "project_profile",
          key: "project:language",
        }),
        secretScan: cleanScan(),
        similar: [
          makeSimilar("old", {
            scope: "user",
            scopeId: "user_1",
            type: "user_preference",
            key: "user_preference:language",
            relevance: 0.8,
          }),
        ],
      });
      // Different scope → no contradiction → create
      expect(result.action).toBe("create");
    });
  });

  describe("computeQualityScore", () => {
    test("user_explicit source gets highest credibility", () => {
      const score = policy.computeQualityScore({
        candidate: { source: "user_explicit", confidence: 0.8, importance: 0.6 },
        hasConflicts: false,
      });
      expect(score.sourceCredibility).toBe(0.95);
      // score = 0.95*0.30 + 0.88*0.20 + 0.05 + 0.6*0.15 + 0 + 0.05 = 0.651
      expect(score.score).toBeGreaterThan(0.6);
      expect(score.score).toBeLessThan(1.0);
    });

    test("agent_task_summary source gets medium credibility", () => {
      const score = policy.computeQualityScore({
        candidate: { source: "agent_task_summary", confidence: 0.8, importance: 0.6 },
        hasConflicts: false,
      });
      expect(score.sourceCredibility).toBe(0.75);
    });

    test("userConfirmed boosts score", () => {
      const noConfirm = policy.computeQualityScore({
        candidate: { source: "agent_task_summary", confidence: 0.8, importance: 0.6 },
        hasConflicts: false,
      });
      const confirmed = policy.computeQualityScore({
        candidate: { source: "agent_task_summary", confidence: 0.8, importance: 0.6 },
        hasConflicts: false,
        userConfirmed: true,
      });
      expect(confirmed.score).toBeGreaterThan(noConfirm.score);
    });

    test("hasConflicts penalizes score", () => {
      const noConflict = policy.computeQualityScore({
        candidate: { source: "user_explicit", confidence: 0.8, importance: 0.6 },
        hasConflicts: false,
      });
      const withConflict = policy.computeQualityScore({
        candidate: { source: "user_explicit", confidence: 0.8, importance: 0.6 },
        hasConflicts: true,
      });
      expect(noConflict.score).toBeGreaterThan(withConflict.score);
    });

    test("hasToolEvidence adds to score", () => {
      const noEvidence = policy.computeQualityScore({
        candidate: { source: "agent_task_summary", confidence: 0.8, importance: 0.6 },
        hasConflicts: false,
      });
      const withEvidence = policy.computeQualityScore({
        candidate: { source: "agent_task_summary", confidence: 0.8, importance: 0.6 },
        hasConflicts: false,
        hasToolEvidence: true,
      });
      expect(withEvidence.score).toBeGreaterThan(noEvidence.score);
    });

    test("score never exceeds 1.0", () => {
      const score = policy.computeQualityScore({
        candidate: { source: "user_explicit", confidence: 1.0, importance: 1.0 },
        hasConflicts: false,
        userConfirmed: true,
        hasToolEvidence: true,
      });
      expect(score.score).toBeLessThanOrEqual(1.0);
    });

    test("unknown source defaults to 0.55 credibility", () => {
      const score = policy.computeQualityScore({
        candidate: { source: "unknown_source", confidence: 0.8, importance: 0.6 },
        hasConflicts: false,
      });
      expect(score.sourceCredibility).toBe(0.55);
    });
  });
});
