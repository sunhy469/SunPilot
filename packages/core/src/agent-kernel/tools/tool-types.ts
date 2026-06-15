import type { Permission, RiskLevel } from "../loop-types.js";

/** Re-export tool-related types */
export type { PlannedToolCall, ToolDecision } from "../loop-types.js";

/**
 * Skill manifest summary — the minimum information ToolDecisionEngine
 * needs to select a skill. Mirrors the full SkillManifest from protocol
 * but only carries decision-relevant fields.
 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category:
    | "filesystem"
    | "shell"
    | "code"
    | "web"
    | "memory"
    | "artifact"
    | "automation"
    | "custom";
  enabled: boolean;
  permissions: Permission[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  supportsAbort: boolean;
  idempotent: boolean;
  /** Capability input schema (JSON Schema or simple field definitions). */
  inputSchema?: Record<string, unknown>;
  riskHints: {
    defaultRisk: RiskLevel;
    destructiveArgs?: string[];
    externalHosts?: string[];
  };
}

/** Normalized tool result after execution. */
export interface NormalizedToolResult {
  toolCallId: string;
  status: "completed" | "failed" | "cancelled" | "timeout";
  summary: string;
  content?: string;
  artifacts: Array<{ id: string; name: string; type: string }>;
  structured?: Record<string, unknown>;
  stdout?: string;
  stderr?: string;
  error?: {
    code: string;
    message: string;
  };
  tokenEstimate: number;
  redacted: boolean;
}

/**
 * Map intent types to likely skill ids for fallback selection
 * when the LLM doesn't specify which skill to use.
 */
export const INTENT_SKILL_MAP: Record<string, string[]> = {
  casual_chat: [],
  question_answering: [],
  project_analysis: ["filesystem.read"],
  code_generation: ["filesystem.write", "filesystem.read"],
  code_modification: ["filesystem.read", "filesystem.write"],
  file_operation: ["filesystem.read", "filesystem.write"],
  shell_operation: ["shell.execute"],
  automation_execution: [],
  artifact_generation: ["artifact.write"],
  memory_update: ["memory.write"],
  diagnostics: ["filesystem.read", "shell.execute"],
  use_skill: [],
  unknown: [],
};
