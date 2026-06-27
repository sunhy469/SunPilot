import type { ToolDefinition } from "../../../llm/llm.types.js";
import type { ToolRetrievalResult } from "../tool-retriever.js";

const TOPK_BY_INTENT: Partial<Record<string, number>> = {
  casual_chat: 0,
  question_answering: 5,
  memory_update: 0,
  image_analysis: 5,
  product_search: 5,
  use_skill: 5,
  file_operation: 3,
  shell_operation: 3,
  default: 15,
};

export function buildStreamingToolDefinitions(
  retrieval: ToolRetrievalResult,
  intent?: { type: string; candidateSkills?: string[] },
  overrideLimit?: number,
): {
  tools: ToolDefinition[];
  nameMap: Map<string, string>;
} {
  const limit = overrideLimit ?? (intent
    ? (TOPK_BY_INTENT[intent.type] ?? TOPK_BY_INTENT.default!)
    : TOPK_BY_INTENT.default!);

  const candidates = new Set(intent?.candidateSkills ?? []);
  const sorted = [...retrieval.tools].sort((a, b) => {
    const aIsCandidate = candidates.has(a.skill.id) ? 0 : 1;
    const bIsCandidate = candidates.has(b.skill.id) ? 0 : 1;
    return aIsCandidate - bIsCandidate || b.score - a.score;
  });

  const topTools = sorted.slice(0, limit);
  const usedNames = new Set<string>();
  const nameMap = new Map<string, string>();

  const tools = topTools.map((scored) => {
    const skill = scored.skill;
    const functionName = toProviderToolName(skill.id, usedNames);
    nameMap.set(functionName, skill.id);
    const parameters = normalizeSchemaForLLM(skill.inputSchema);

    return {
      type: "function" as const,
      function: {
        name: functionName,
        description: `${skill.name}: ${skill.description}${
          scored.matchReasons && scored.matchReasons.length > 0
            ? ` (matched: ${scored.matchReasons.join(", ")})`
            : ""
        }\nSunPilot skill id: ${skill.id}`,
        parameters,
      },
    };
  });

  return { tools, nameMap };
}

function toProviderToolName(skillId: string, usedNames: Set<string>): string {
  const base = skillId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);
  const fallback = base.length > 0 ? base : "tool";
  let candidate = fallback;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${fallback.slice(0, 52)}_${suffix}`;
    suffix++;
  }
  usedNames.add(candidate);
  return candidate;
}

function normalizeSchemaForLLM(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, additionalProperties: true };
  }

  const normalized = { ...schema };
  const anyOf = normalized.anyOf;
  const oneOf = normalized.oneOf;
  const hasDisjunction =
    (Array.isArray(anyOf) && anyOf.length > 0) ||
    (Array.isArray(oneOf) && oneOf.length > 0);

  delete normalized.anyOf;
  delete normalized.oneOf;
  delete normalized.allOf;

  if (
    hasDisjunction &&
    (!Array.isArray(normalized.required) || normalized.required.length === 0)
  ) {
    normalized.required = [];

    const branches = (Array.isArray(anyOf) ? anyOf : []) as Array<
      Record<string, unknown>
    >;
    const altBranches = (Array.isArray(oneOf) ? oneOf : []) as Array<
      Record<string, unknown>
    >;
    const allBranches = [...branches, ...altBranches];
    const branchFields = allBranches
      .map((b) => (Array.isArray(b.required) ? b.required.join(" + ") : ""))
      .filter(Boolean);
    if (branchFields.length > 0) {
      const hint = ` [至少提供其一: ${branchFields.join(" 或 ")}]`;
      normalized.description =
        (typeof normalized.description === "string"
          ? normalized.description
          : "") + hint;
    }
  }

  if (normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false;
  }

  return normalized;
}
