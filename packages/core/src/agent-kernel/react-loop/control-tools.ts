import type { ToolCall, ToolDefinition } from "../../llm/llm.types.js";

export const REQUEST_USER_INPUT_TOOL_NAME = "agent_request_input";

export const REQUEST_USER_INPUT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: REQUEST_USER_INPUT_TOOL_NAME,
    description:
      "Ask the user for information that is required before the task can continue. Use this instead of guessing missing values.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["question"],
      properties: {
        question: {
          type: "string",
          description: "A concise question in the same language as the user.",
        },
        missingFields: {
          type: "array",
          items: { type: "string" },
          description: "Optional machine-readable names of missing fields.",
        },
      },
    },
  },
};

export interface RequestUserInputAction {
  question: string;
  missingFields: string[];
}

export function parseRequestUserInput(
  calls: ToolCall[],
): RequestUserInputAction | undefined {
  const call = calls.find(
    (candidate) => candidate.function.name === REQUEST_USER_INPUT_TOOL_NAME,
  );
  if (!call) return undefined;

  try {
    const parsed = JSON.parse(call.function.arguments) as {
      question?: unknown;
      missingFields?: unknown;
    };
    if (typeof parsed.question !== "string" || !parsed.question.trim()) {
      return {
        question: "请补充继续完成任务所需的信息。",
        missingFields: [],
      };
    }
    return {
      question: parsed.question.trim(),
      missingFields: Array.isArray(parsed.missingFields)
        ? parsed.missingFields.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    };
  } catch {
    return {
      question: "请补充继续完成任务所需的信息。",
      missingFields: [],
    };
  }
}
