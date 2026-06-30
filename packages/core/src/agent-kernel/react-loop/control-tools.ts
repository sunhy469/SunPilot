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

export interface RequestUserInputMatch {
  call: ToolCall;
  action?: RequestUserInputAction;
  error?: string;
}

export function parseRequestUserInput(
  calls: ToolCall[],
): RequestUserInputMatch | undefined {
  const call = calls.find(
    (candidate) => candidate.function.name === REQUEST_USER_INPUT_TOOL_NAME,
  );
  if (!call) return undefined;

  if (calls.length !== 1) {
    return {
      call,
      error: "agent_request_input must be the only tool call in its model turn",
    };
  }

  try {
    const parsed = JSON.parse(call.function.arguments) as {
      question?: unknown;
      missingFields?: unknown;
    };
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { call, error: "agent_request_input arguments must be a JSON object" };
    }
    const unexpected = Object.keys(parsed).filter(
      (key) => key !== "question" && key !== "missingFields",
    );
    if (unexpected.length > 0) {
      return {
        call,
        error: `agent_request_input contains unexpected fields: ${unexpected.join(", ")}`,
      };
    }
    if (typeof parsed.question !== "string" || !parsed.question.trim()) {
      return { call, error: "agent_request_input requires a non-empty question" };
    }
    if (
      parsed.missingFields !== undefined &&
      (!Array.isArray(parsed.missingFields) ||
        parsed.missingFields.some((value) => typeof value !== "string"))
    ) {
      return { call, error: "agent_request_input missingFields must be a string array" };
    }
    return {
      call,
      action: {
        question: parsed.question.trim(),
        missingFields: Array.isArray(parsed.missingFields)
          ? parsed.missingFields
          : [],
      },
    };
  } catch (error) {
    return {
      call,
      error: error instanceof Error
        ? `agent_request_input arguments are invalid JSON: ${error.message}`
        : "agent_request_input arguments are invalid JSON",
    };
  }
}
