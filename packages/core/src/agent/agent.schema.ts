import type { AgentChatRequest } from "./agent.types.js";

export function parseAgentChatRequest(input: unknown): AgentChatRequest {
  if (!isRecord(input)) {
    throw new Error("Agent chat request must be an object.");
  }
  const conversationId = input.conversationId;
  const message = input.message;
  if (conversationId !== undefined && typeof conversationId !== "string") {
    throw new Error("conversationId must be a string when provided.");
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("message is required.");
  }
  return {
    conversationId,
    message: message.trim()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
