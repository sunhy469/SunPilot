import { describe, expect, test } from "vitest";
import type { LlmProvider } from "../llm/index.js";
import { AgentService } from "./agent.service.js";
import { InMemoryAgentConversationStore } from "./conversation.service.js";

async function* streamText(...parts: string[]) {
  for (const delta of parts) yield { delta, raw: {} };
}

describe("AgentService", () => {
  test("creates a conversation, stores messages, and returns the assistant reply", async () => {
    const conversations = new InMemoryAgentConversationStore();
    const calls: Array<unknown> = [];
    const llm: LlmProvider = {
      id: "test.llm",
      model: "test-model",
      streamChat(request) {
        calls.push(request);
        return streamText("hello ", "from ", "assistant");
      }
    };
    const agent = new AgentService({ llm, conversations, systemPrompt: "Be concise." });

    const response = await agent.chat({ message: "hello" });

    expect(response.conversationId).toMatch(/^conv_/);
    expect(response.message).toMatchObject({
      conversationId: response.conversationId,
      role: "assistant",
      content: "hello from assistant"
    });
    await expect(conversations.listMessages(response.conversationId)).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
      expect.objectContaining({ role: "assistant", content: "hello from assistant" })
    ]);
    expect(calls).toEqual([
      {
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "hello" }
        ]
      }
    ]);
  });

  test("emits chat lifecycle hooks", async () => {
    const conversations = new InMemoryAgentConversationStore();
    const agent = new AgentService({
      conversations,
      llm: {
        id: "test.llm",
        model: "test-model",
        streamChat() {
          return streamText("hook ", "reply");
        }
      }
    });
    const events: string[] = [];

    const response = await agent.chat({ message: "hook hello" }, {
      onUserMessage(message) {
        events.push(`user:${message.content}`);
      },
      onAssistantStarted({ messageId }) {
        events.push(`started:${messageId}`);
      },
      onAssistantDelta({ delta }) {
        events.push(`delta:${delta}`);
      },
      onAssistantMessage(message) {
        events.push(`assistant:${message.id}:${message.content}`);
      }
    });

    expect(events).toEqual([
      "user:hook hello",
      `started:${response.message.id}`,
      "delta:hook ",
      "delta:reply",
      `assistant:${response.message.id}:hook reply`
    ]);
  });

  test("rejects unknown conversations", async () => {
    const agent = new AgentService({
      conversations: new InMemoryAgentConversationStore(),
      llm: {
        id: "test.llm",
        model: "test-model",
        async *streamChat() {
          throw new Error("should not call llm");
        }
      }
    });

    await expect(agent.chat({ conversationId: "conv_missing", message: "hello" })).rejects.toThrow("Unknown conversation: conv_missing");
  });
});
