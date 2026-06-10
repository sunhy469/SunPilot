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
 * Default intent rules. Architecture doc §10.3 recommends:
 *   rule matching → light model → full model
 */
export const DEFAULT_INTENT_RULES: IntentRule[] = [
  {
    type: "casual_chat",
    patterns: [
      /^(hi|hello|hey|你好|こんにちは|bonjour|hola)[!.\s]*$/i,
      /^(how are you|what's up|sup\b)/i,
      /^(thanks|thank you|thx|ok|okay|got it)[!.\s]*$/i,
      /^(good (morning|afternoon|evening|night))/i,
    ],
    requiresPlanning: false,
    requiresTool: false,
    requiresApproval: false,
    riskLevel: "low",
    candidateSkills: [],
  },
  {
    type: "file_operation",
    patterns: [
      /\b(read|open|show|cat|view)\s+(the\s+)?file\b/i,
      /\blist\s+(files?|director(y|ies)|contents?)\b/i,
      /\b(write|create|make|generate)\s+(a\s+)?file\b/i,
      /\bdelete\s+(the\s+)?file\b/i,
    ],
    requiresPlanning: false,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "medium",
    candidateSkills: ["filesystem.read", "filesystem.write"],
  },
  {
    type: "shell_operation",
    patterns: [
      /\b(run|execute|start|launch)\s+(pnpm|npm|yarn|node|tsc|vitest|jest|docker|git)\b/i,
      /\b(build|test|lint|format|deploy|install)\s+(the\s+)?(project|app|code)\b/i,
      /\bpnpm\s+(install|build|test|lint|dev|start)\b/i,
      /\bnpm\s+(install|run|build|test|start)\b/i,
    ],
    requiresPlanning: false,
    requiresTool: true,
    requiresApproval: true,
    riskLevel: "high",
    candidateSkills: ["shell.execute"],
  },
  {
    type: "code_generation",
    patterns: [
      /\b(write|create|generate|code|implement|build)\s+(a\s+)?(function|class|component|module|api|endpoint|route)\b/i,
      /\bcreate\s+(a\s+)?(new\s+)?(react\s+)?component\b/i,
    ],
    requiresPlanning: true,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "medium",
    candidateSkills: ["filesystem.write"],
  },
  {
    type: "code_modification",
    patterns: [
      /\b(fix|modify|update|change|refactor|edit|patch|rewrite)\s+(the\s+)?(code|function|file|bug|issue)\b/i,
      /\bdebug\s+(the\s+)?\b/i,
      /\boptimize\s+(the\s+)?\b/i,
    ],
    requiresPlanning: true,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "medium",
    candidateSkills: ["filesystem.read", "filesystem.write"],
  },
  {
    type: "project_analysis",
    patterns: [
      /\b(analyze|analyse|review|audit|check|inspect|examine|assess)\s+(the\s+)?(project|codebase|architecture|structure|code)\b/i,
      /\b(how\s+is|tell\s+me\s+about|explain|describe)\s+(the\s+)?(project|codebase|architecture)\b/i,
    ],
    requiresPlanning: true,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "low",
    candidateSkills: ["filesystem.read"],
  },
  {
    type: "artifact_generation",
    patterns: [
      /\b(generate|create|write|produce)\s+(a\s+)?(document|report|summary|readme|diagram)\b/i,
      /\bcreate\s+(a\s+)?markdown\b/i,
    ],
    requiresPlanning: true,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "low",
    candidateSkills: ["artifact.write"],
  },
  {
    type: "automation_execution",
    patterns: [
      /\b(run|start|execute|launch)\s+(the\s+)?(automation|workflow)\b/i,
      /\b(automation|workflow)\s+(run|start|execute|launch)\b/i,
      /\buse\s+(the\s+)?(automation|workflow)\b/i,
    ],
    requiresPlanning: false,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "medium",
    candidateSkills: [],
  },
  {
    type: "question_answering",
    patterns: [
      /\b(what|how|why|when|where|who|can you|explain|tell me|describe)\b/i,
    ],
    requiresPlanning: false,
    requiresTool: false,
    requiresApproval: false,
    riskLevel: "low",
    candidateSkills: [],
  },
];
