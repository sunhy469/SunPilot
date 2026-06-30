import type { ToolDefinition } from "../../llm/llm.types.js";
import type { ToolCatalogResult } from "./tool-catalog-retriever.js";

/** Convert a ranked catalog into provider-native function definitions. */
export function buildToolDefinitions(
  retrieval: ToolCatalogResult,
  limit: number,
): {
  tools: ToolDefinition[];
  nameMap: Map<string, string>;
} {
  const topTools = [...retrieval.tools]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, limit));
  const usedNames = new Set<string>();
  const nameMap = new Map<string, string>();

  const tools = topTools.map((scored) => {
    const skill = scored.skill;
    const functionName = toProviderToolName(skill.id, usedNames);
    nameMap.set(functionName, skill.id);
    return {
      type: "function" as const,
      function: {
        name: functionName,
        description: `${skill.name}: ${skill.description}${
          scored.matchReasons.length > 0
            ? ` (matched: ${scored.matchReasons.join(", ")})`
            : ""
        }\nSunPilot skill id: ${skill.id}`,
        parameters: normalizeSchemaForLlm(skill.inputSchema),
      },
    };
  });

  return { tools, nameMap };
}

function toProviderToolName(skillId: string, usedNames: Set<string>): string {
  const base = skillId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);
  const fallback = base || "tool";
  let candidate = fallback;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${fallback.slice(0, 52)}_${suffix++}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function normalizeSchemaForLlm(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, additionalProperties: true };
  }

  const normalized = { ...schema };

  // Default additionalProperties to false so the LLM won't invent extra fields.
  // anyOf / oneOf / allOf / required are kept as-is — modern LLMs handle JSON
  // Schema composition keywords natively, and stripping them causes a mismatch
  // with the runtime validator (ToolCallGuard) which uses the original schema.
  if (normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false;
  }
  return normalized;
}
