import type { SkillSummary } from "../tool-types.js";

export type ToolLoopStopReason =
  | "missing_required_arguments"
  | "schema_validation_failed"
  | "permission_denied"
  | "all_tools_failed"
  | "duplicate_tool_call_blocked"
  | "max_iterations";

/** Audit metadata recorded on each PlannedToolCall for debugging tool selection. */
export interface DecisionMetadata {
  decisionPath:
    | "plan"
    | "intent_match"
    | "priority"
    | "deterministic_scorer"
    | "llm_semantic"
    | "scorer_fallback"
    | "intent_skill_map"
    | "no_tool";
  llmSelectionUsed: boolean;
  retrievalMetadata?: {
    query: string;
    topK: number;
    candidates: Array<{
      skillId: string;
      score: number;
      matchReasons: string[];
    }>;
    fallbackUsed: boolean;
  };
  clarificationReason?: string;
}

export interface LlmToolDecision {
  decision: "select" | "none" | "clarify";
  skillId?: string;
  confidence: number;
  reason: string;
  missingInfo?: string;
}

export interface ScoredSkill {
  skill: SkillSummary;
  score: number;
  matchReasons?: string[];
}

export interface ToolCallAccumulator {
  index: number;
  id: string;
  type: "function";
  functionName: string;
  functionArguments: string;
}
