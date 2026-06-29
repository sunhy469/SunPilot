import type { AgentChatRequest } from "./agent.types.js";
import { chatSendSchema } from "@sunpilot/protocol";

export function parseAgentChatRequest(input: unknown): AgentChatRequest {
  const parsed = chatSendSchema.parse(input);
  return {
    conversationId: parsed.conversationId,
    message: parsed.message.trim(),
    attachments: parsed.attachments,
  };
}
