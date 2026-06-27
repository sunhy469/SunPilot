import { MAX_TOOL_ITERATIONS } from "../../agent-loop-engine/constants.js";
import type { AgentPlan, RoutedIntent, ToolDecision } from "../../loop-types.js";
import type { SkillSummary } from "../tool-types.js";
import type { DecisionMetadata, ScoredSkill } from "./types.js";

export function capabilityNameFromToolId(toolId: string): string | undefined {
  const separator = toolId.indexOf(":");
  return separator >= 0 ? toolId.slice(separator + 1) : undefined;
}

export function maxRisk(
  left: "low" | "medium" | "high" | "critical",
  right: "low" | "medium" | "high" | "critical",
): "low" | "medium" | "high" | "critical" {
  const order = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return order[left] >= order[right] ? left : right;
}

export function scoreSkills(
  message: string,
  skills: SkillSummary[],
): ScoredSkill[] {
  const lower = message.toLowerCase();

  const scored = skills.map((skill) => {
    let score = 0;

    if (lower.includes(skill.id.toLowerCase())) {
      score = Math.max(score, 1.0);
    }

    const capName = capabilityNameFromToolId(skill.id);
    if (capName && lower.includes(capName.toLowerCase())) {
      score = Math.max(score, 1.0);
    }

    if (lower.includes(skill.name.toLowerCase())) {
      score = Math.max(score, 0.5);
    }

    const nameBigrams = extractBigrams(skill.name);
    const nameOverlap = nameBigrams.filter((bg) => lower.includes(bg));
    if (nameOverlap.length >= 2) {
      score = Math.max(score, 0.15);
    } else if (nameOverlap.length === 1) {
      score = Math.max(score, 0.1);
    }

    const descWords = skill.description.toLowerCase().split(/\s+/);
    const matchedWords = descWords.filter(
      (w) => w.length > 1 && lower.includes(w),
    );
    const descBigrams = extractBigrams(skill.description);
    const matchedBigrams = descBigrams.filter((bg) => lower.includes(bg));

    const totalDescMatches = matchedWords.length + matchedBigrams.length;
    if (totalDescMatches >= 3) {
      score = Math.max(score, 0.1);
    } else if (totalDescMatches >= 1) {
      score = Math.max(score, 0.05);
    }

    if (lower.includes(skill.category.toLowerCase())) {
      score = Math.max(score, 0.4);
    }

    return { skill, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export function deriveRecentHistory(
  toolResults: Array<{
    toolCallId: string;
    summary: string;
    content?: string;
    status: string;
    name?: string;
    skillId?: string;
    structured?: Record<string, unknown>;
  }>,
): Array<{
  skillId: string;
  status: "completed" | "failed" | "timeout" | "rejected";
  timestamp: string;
}> {
  return toolResults
    .filter((tr) => tr.status !== "pending" && tr.status !== "running")
    .map((tr) => {
      const resolvedSkillId =
        tr.skillId ??
        (tr.name?.includes(":")
          ? tr.name.slice(0, tr.name.lastIndexOf(":"))
          : undefined) ??
        ((tr.structured as Record<string, unknown> | undefined)?.skillId as
          | string
          | undefined);
      if (!resolvedSkillId) return null;

      const historyStatus =
        tr.status === "completed"
          ? ("completed" as const)
          : tr.status === "failed" || tr.status === "timeout"
            ? (tr.status as "failed" | "timeout")
            : tr.status === "cancelled"
              ? ("rejected" as const)
              : ("failed" as const);

      return {
        skillId: resolvedSkillId,
        status: historyStatus,
        timestamp: new Date().toISOString(),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

export function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

export function summarizeForPreview(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 80) {
      preview[key] = value.slice(0, 80) + "...";
    } else if (Array.isArray(value) && value.length > 3) {
      preview[key] = `[${value.length} items]`;
    } else {
      preview[key] = value;
    }
  }
  return preview;
}

export function attachTrace(
  decision: ToolDecision,
  meta?: DecisionMetadata,
): ToolDecision {
  if (meta) {
    decision.decisionPath = meta.decisionPath;
    if (meta.retrievalMetadata) {
      decision.retrievalTopK = meta.retrievalMetadata.topK;
      decision.retrievalCandidateCount =
        meta.retrievalMetadata.candidates?.length;
      decision.retrievalFallback = meta.retrievalMetadata.fallbackUsed;
    }
  }
  return decision;
}

export function stableStringifyArgs(args: string): string {
  try {
    const parsed = JSON.parse(args);
    return JSON.stringify(parsed, Object.keys(parsed).sort());
  } catch {
    return args;
  }
}

export function computeMaxIterations(
  intent: RoutedIntent,
  plan?: AgentPlan,
): number {
  if (plan && plan.steps.length > 0) {
    return Math.max(MAX_TOOL_ITERATIONS, plan.steps.length + 2);
  }
  if (intent.type === "project_analysis") return 8;
  if (intent.type === "automation_execution") return 10;
  if (intent.type === "artifact_generation") return 8;
  return MAX_TOOL_ITERATIONS;
}

function extractBigrams(text: string): string[] {
  const result: string[] = [];
  const cjk = /[一-鿿㐀-䶿]{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = cjk.exec(text)) !== null) {
    const seg = match[0];
    for (let i = 0; i < seg.length - 1; i++) {
      result.push(seg.slice(i, i + 2));
    }
  }
  const tokens = /[a-z0-9]{2,}/gi;
  while ((match = tokens.exec(text)) !== null) {
    result.push(match[0].toLowerCase());
  }
  return result;
}
