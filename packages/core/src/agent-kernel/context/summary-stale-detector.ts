/**
 * Summary Stale Detector — detects when conversation summaries need
 * to be invalidated or regenerated due to changing context (§6).
 *
 * Detection triggers:
 * - New messages change the user's goal
 * - Tool results change established facts
 * - User corrections invalidate prior information
 * - New explicit preferences conflict with older inference
 */

export interface StaleDetectionInput {
  /** The existing summary or memory record to check. */
  summary: {
    id: string;
    content: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  };
  /** New messages since the summary was created. */
  newMessages: Array<{
    role: string;
    content: string;
  }>;
  /** New tool results since the summary was created. */
  newToolResults?: Array<{
    skillId: string;
    summary: string;
    status: string;
  }>;
}

export interface StaleDetectionResult {
  /** Whether the summary is now stale. */
  stale: boolean;
  /** The reason(s) why it became stale. */
  reasons: string[];
  /** Severity: 'info' (minor), 'warning' (should regenerate soon), 'critical' (invalid now). */
  severity: "info" | "warning" | "critical";
  /** Whether the stale summary should still be shown to the model (with a warning). */
  keepWithWarning: boolean;
}

/**
 * Goal-change patterns that indicate a summary may be stale.
 */
const GOAL_CHANGE_PATTERNS = [
  // English
  /\b(?:actually|instead|change of plans|new goal|different approach|scratch that|never mind|on second thought)\b/i,
  /\b(?:let's do|I want to|I'd rather|switch|pivot|redirect)\b/i,
  // Chinese
  /(?:其实|换个|改成|算了|不对|重新|换一个|不做了|不找了|不搜了)/,
];

/**
 * Fact-change patterns that indicate tool results have changed the situation.
 */
const FACT_CHANGE_PATTERNS = [
  /\b(?:no longer|not anymore|changed|updated|deprecated|removed|replaced)\b/i,
  /(?:已经|没有|不在了|变了|更新了|改成了|失效了|过期了)/,
];

/**
 * Correction patterns — user is explicitly correcting prior information.
 */
const CORRECTION_PATTERNS = [
  /\b(?:correction|actually|no,|wrong|that's not right|you misunderstood)\b/i,
  /(?:纠正|不对|错了|不是|不是这样|你理解错了|我指的是|我的意思是)/,
];

/**
 * SummaryStaleDetector — checks whether conversation summaries have gone stale.
 *
 * Usage: call `checkStale()` whenever new messages or tool results arrive
 * after a summary was created. If stale, the summary should be regenerated
 * or marked with a warning so the model knows the information may be outdated.
 */
export class SummaryStaleDetector {
  /**
   * Check if a summary is stale given new context.
   */
  checkStale(input: StaleDetectionInput): StaleDetectionResult {
    const reasons: string[] = [];

    // ── Check 1: New messages change the goal ───────────────────────
    const goalChangeMessages = input.newMessages.filter(
      (m) =>
        m.role === "user" &&
        GOAL_CHANGE_PATTERNS.some((p) => p.test(m.content)),
    );
    if (goalChangeMessages.length > 0) {
      reasons.push(
        `Goal changed by user message: "${goalChangeMessages[0]!.content.slice(0, 100)}"`,
      );
    }

    // ── Check 2: Tool results change facts ──────────────────────────
    if (input.newToolResults && input.newToolResults.length > 0) {
      const factChangingResults = input.newToolResults.filter(
        (tr) =>
          tr.status === "completed" &&
          FACT_CHANGE_PATTERNS.some((p) => p.test(tr.summary)),
      );
      if (factChangingResults.length > 0) {
        reasons.push(
          `Tool results changed established facts: ${factChangingResults.map((r) => r.skillId).join(", ")}`,
        );
      }
    }

    // ── Check 3: User corrections ──────────────────────────────────
    const correctionMessages = input.newMessages.filter(
      (m) =>
        m.role === "user" &&
        CORRECTION_PATTERNS.some((p) => p.test(m.content)),
    );
    if (correctionMessages.length > 0) {
      reasons.push(
        `User corrected prior information: "${correctionMessages[0]!.content.slice(0, 100)}"`,
      );
    }

    // ── Check 4: Memory merge policy — explicit overrides inference ─
    // If a new user message explicitly states a preference that conflicts
    // with what was in the summary, the summary is stale.
    const explicitPreferenceMessages = input.newMessages.filter(
      (m) =>
        m.role === "user" &&
        /\b(?:prefer|preference|喜欢|偏好|想要|需要|must|必须|should|应该|always|总是|never|从不)\b/i.test(
          m.content,
        ),
    );
    if (explicitPreferenceMessages.length > 0) {
      // Compare with summary content for potential conflict
      const summaryLower = input.summary.content.toLowerCase();
      for (const msg of explicitPreferenceMessages) {
        // Simple heuristic: if the message contains a preference keyword
        // and the summary has content about the same topic, flag it
        const msgLower = msg.content.toLowerCase();
        const topicWords = msgLower
          .split(/\s+/)
          .filter(
            (w) => w.length > 3 && !["prefer", "preference", "喜欢", "偏好"].includes(w),
          );
        const topicOverlap = topicWords.filter((w) =>
          summaryLower.includes(w),
        );
        if (topicOverlap.length >= 2) {
          reasons.push(
            `New explicit preference may override summary: "${msg.content.slice(0, 100)}"`,
          );
          break;
        }
      }
    }

    // ── Check 5: Topic drift (§7.5) ─────────────────────────────────
    // Compare keyword overlap between new USER messages and summary content.
    // If overlap < 30%, the conversation has drifted to a new topic and
    // the summary may be outdated. This is especially important for pure
    // chat scenarios where no tool results trigger fact-change detection.
    //
    // Only user messages are considered (assistant messages don't signal
    // user intent drift), and at least 3 keywords are required to avoid
    // false positives on short follow-up questions like "can you explain
    // more about that?" which produce too few meaningful keywords.
    const userMessages = input.newMessages.filter((m) => m.role === "user");
    if (userMessages.length > 0) {
      const summaryKeywords = extractKeywords(input.summary.content);
      const userContent = userMessages.map((m) => m.content).join(" ");
      const newKeywords = extractKeywords(userContent);
      const MIN_DRIFT_KEYWORDS = 3;

      if (
        summaryKeywords.size > 0 &&
        newKeywords.size >= MIN_DRIFT_KEYWORDS
      ) {
        let shared = 0;
        for (const kw of newKeywords) {
          if (summaryKeywords.has(kw)) shared++;
        }
        const union = summaryKeywords.size + newKeywords.size - shared;
        const overlapRatio = union > 0 ? shared / union : 0;

        if (overlapRatio < 0.3) {
          reasons.push(
            `Topic drift detected: keyword overlap ${(overlapRatio * 100).toFixed(0)}% < 30% — conversation may have moved to a new topic`,
          );
        }
      }
    }

    // ── Determine severity ──────────────────────────────────────────
    if (reasons.length === 0) {
      return {
        stale: false,
        reasons: [],
        severity: "info",
        keepWithWarning: false,
      };
    }

    const hasGoalChange = goalChangeMessages.length > 0;
    const hasCorrection = correctionMessages.length > 0;
    const hasFactChange =
      input.newToolResults &&
      input.newToolResults.length > 0 &&
      reasons.some((r) => r.includes("Tool results changed"));

    let severity: "info" | "warning" | "critical";
    let keepWithWarning: boolean;

    if (hasGoalChange || hasCorrection) {
      // Goal change or user correction → summary is critically stale
      severity = "critical";
      keepWithWarning = true; // Still show but with strong caveat
    } else if (hasFactChange) {
      // Tool results changed facts → warning level
      severity = "warning";
      keepWithWarning = true;
    } else {
      // Minor — new preference may conflict
      severity = "warning";
      keepWithWarning = true;
    }

    return {
      stale: true,
      reasons,
      severity,
      keepWithWarning,
    };
  }

  /**
   * Check if a set of new messages since the summary was created
   * indicate the summary should be marked stale.
   *
   * Convenience method that creates a StaleDetectionInput from primitives.
   */
  checkFromMessages(params: {
    summaryId: string;
    summaryContent: string;
    summaryCreatedAt: string;
    summaryMetadata?: Record<string, unknown>;
    newMessagesSince: Array<{ role: string; content: string }>;
    newToolResultsSince?: Array<{
      skillId: string;
      summary: string;
      status: string;
    }>;
  }): StaleDetectionResult {
    return this.checkStale({
      summary: {
        id: params.summaryId,
        content: params.summaryContent,
        metadata: params.summaryMetadata,
        createdAt: params.summaryCreatedAt,
      },
      newMessages: params.newMessagesSince,
      newToolResults: params.newToolResultsSince,
    });
  }
}

/**
 * §7.5: Extract keywords from text for topic-drift overlap comparison.
 *
 * Handles both English (whitespace tokenization) and Chinese (bigram
 * extraction) text. Filters out common stop words and very short tokens.
 * Returns a Set of lowercase keywords.
 */
const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "can", "to", "of", "in", "on", "at",
  "by", "for", "with", "about", "as", "into", "through", "during", "and",
  "or", "but", "if", "then", "that", "this", "these", "those", "it", "its",
  "from", "they", "them", "their", "there", "here", "what", "which", "who",
  "when", "where", "why", "how", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "not", "only", "own",
  "same", "so", "than", "too", "very", "just", "also", "now", "you", "your",
  "i", "me", "my", "we", "us", "our", "he", "she", "him", "her", "his",
  // Common Chinese stop chars
  "的", "了", "是", "在", "我", "你", "他", "她", "它", "们", "和", "与",
  "或", "但", "如果", "因为", "所以", "虽然", "但是", "不过", "然后",
  "现在", "这个", "那个", "这些", "那些", "什么", "怎么", "为什么",
  "可以", "需要", "应该", "已经", "正在", "一个", "一些", "没有", "不",
]);

function extractKeywords(text: string): Set<string> {
  const keywords = new Set<string>();
  const lower = text.toLowerCase();

  // English: split on non-alphanumeric, filter stop words and short tokens
  const englishTokens = lower.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  for (const token of englishTokens) {
    if (!STOP_WORDS.has(token)) {
      keywords.add(token);
    }
  }

  // Chinese: extract 2-character bigrams from CJK ranges
  const cjkChars = [...lower].filter(
    (c) => c.charCodeAt(0) >= 0x4e00 && c.charCodeAt(0) <= 0x9fff,
  );
  for (let i = 0; i < cjkChars.length - 1; i++) {
    const bigram = cjkChars[i]! + cjkChars[i + 1]!;
    if (!STOP_WORDS.has(bigram)) {
      keywords.add(bigram);
    }
  }

  return keywords;
}
