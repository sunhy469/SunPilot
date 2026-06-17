import type { IntentType, RiskLevel } from "../loop-types.js";

/** Re-export from loop-types for convenience */
export type { IntentType, RoutedIntent } from "../loop-types.js";

/**
 * Rule-based intent pattern — matched before calling an LLM.
 * Fast path for common phrases that don't need model inference.
 */
export interface IntentRule {
  type: IntentType;
  patterns: RegExp[];
  requiresPlanning: boolean;
  requiresTool: boolean;
  requiresApproval: boolean;
  riskLevel: RiskLevel;
  candidateSkills: string[];
}

/**
 * Default intent rules — FORM-MATCHING ONLY.
 *
 * These rules match the FORM of the user input (structure, syntax),
 * NOT its semantic meaning. Natural-language intent classification
 * is handled by the Embedding + LLM cascade in IntentRouter.
 *
 * Design principle:
 *   Regex → match form   (slash commands, exact short greetings, CLI syntax)
 *   Embedding → match meaning (semantic intent + tool selection)
 *   LLM → final arbitration
 *
 * Architecture doc §10.3 (revised): form-match → embedding → LLM → default
 */
export const DEFAULT_INTENT_RULES: IntentRule[] = [
  // ── Casual chat: exact short formulaic greetings ──────────────────
  // Anchored with ^$ to match ONLY when the entire message is a short
  // greeting — not when greeting words appear in longer sentences.
  {
    type: "casual_chat",
    patterns: [
      /^(hi|hello|hey|你好|您好|こんにちは|bonjour|hola)[!.\s]*$/i,
      /^(thanks|thank you|thx|ok|okay|got it)[!.\s]*$/i,
      /^(good (morning|afternoon|evening|night))[!.\s]*$/i,
    ],
    requiresPlanning: false,
    requiresTool: false,
    requiresApproval: false,
    riskLevel: "low",
    candidateSkills: [],
  },

  // ── Shell: exact CLI command syntax ───────────────────────────────
  // Matches explicit package manager commands with concrete subcommand
  // names. Does NOT match natural-language descriptions like
  // "run the build" or "execute the tests" — those go to embedding/LLM.
  {
    type: "shell_operation",
    patterns: [
      /\b(pnpm|npm|yarn|npx)\s+(install|add|remove|build|test|lint|dev|start|run|exec|deploy|publish|format|check|typecheck)\b/i,
      /\b(node|tsx|ts-node|deno|bun)\s+\S+/i,
      /\b(docker|git|kubectl|helm)\s+\S+/i,
    ],
    requiresPlanning: false,
    requiresTool: true,
    requiresApproval: true,
    riskLevel: "high",
    candidateSkills: ["shell.execute"],
  },
];
