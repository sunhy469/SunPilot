import type { ToolCall, ToolDefinition } from "../../llm/llm.types.js";

const TEXTUAL_CALL_RE =
  /<FunctionCallBegin>\s*(\[[\s\S]*?\])\s*<FunctionCallEnd>/;

/** Compatibility parser for providers that serialize function calls as text. */
export function parseTextualFunctionCalls(
  textContent: string,
  tools: ToolDefinition[] | undefined,
): ToolCall[] {
  const textualMatch = TEXTUAL_CALL_RE.exec(textContent);
  if (!textualMatch || !tools?.length) return [];

  try {
    const parsed = JSON.parse(textualMatch[1]!) as Array<{
      name?: string;
      parameters?: Record<string, unknown>;
    }>;
    if (!Array.isArray(parsed)) return [];
    const availableNames = new Set(tools.map((tool) => tool.function.name));
    return parsed.flatMap((item) =>
      item.name && availableNames.has(item.name)
        ? [{
            id: `textual_${crypto.randomUUID()}`,
            type: "function" as const,
            function: {
              name: item.name,
              arguments: JSON.stringify(item.parameters ?? {}),
            },
          }]
        : [],
    );
  } catch {
    return [];
  }
}
