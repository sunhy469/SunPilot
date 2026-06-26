import type { ToolCall, ToolDefinition } from "../../../llm/llm.types.js";

const TEXTUAL_CALL_RE =
  /<FunctionCallBegin>\s*(\[[\s\S]*?\])\s*<FunctionCallEnd>/;

export function parseTextualFunctionCalls(
  textContent: string,
  tools: ToolDefinition[] | undefined,
): ToolCall[] {
  const textualMatch = TEXTUAL_CALL_RE.exec(textContent);
  if (!textualMatch || !tools || tools.length === 0) return [];

  try {
    const parsed = JSON.parse(textualMatch[1]!) as Array<{
      name?: string;
      parameters?: Record<string, unknown>;
    }>;
    if (!Array.isArray(parsed)) return [];

    const toolByName = new Map<string, ToolDefinition>();
    for (const tool of tools) {
      if (tool.function?.name) toolByName.set(tool.function.name, tool);
    }

    const toolCalls: ToolCall[] = [];
    for (const item of parsed) {
      const fnName = item.name;
      if (!fnName || !toolByName.has(fnName)) continue;
      toolCalls.push({
        id: `textual_${crypto.randomUUID()}`,
        type: "function",
        function: {
          name: fnName,
          arguments: JSON.stringify(item.parameters ?? {}),
        },
      });
    }
    return toolCalls;
  } catch {
    return [];
  }
}
