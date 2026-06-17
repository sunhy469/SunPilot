import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { InMemoryAgentEventBus, type AgentEvent } from "../agent-event-bus.js";
import type { AgentContext, AgentLoopInput } from "../loop-types.js";
import { ResponseComposer } from "./response-composer.js";

const input: AgentLoopInput = {
  runId: "run_response",
  conversationId: "conv_response",
  userMessageId: "msg_user",
  message: "hello",
  mode: "agent",
  client: { source: "api" },
};

const context: AgentContext = {
  runId: input.runId,
  conversationId: input.conversationId,
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: {
    id: input.userMessageId,
    content: input.message,
    attachments: [],
  },
  messages: [],
  memories: [],
  artifacts: [],
  toolResults: [],
  availableSkills: [],
  limits: {
    maxTokens: 8_000,
    reservedForOutput: 1_000,
    usedTokensEstimate: 10,
  },
  tokenEstimate: 10,
};

describe("ResponseComposer", () => {
  test("emits model lifecycle events while streaming response deltas", async () => {
    const eventBus = new InMemoryAgentEventBus();
    const events: AgentEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const savedMessages: Array<{ id: string; content: string }> = [];

    const composer = new ResponseComposer({
      llm: {
        id: "test.provider",
        model: "test-model",
        async *streamChat() {
          yield { delta: "hello " };
          yield { delta: "there" };
        },
      },
      eventBus,
      saveMessage: async (message) => {
        savedMessages.push({ id: message.id, content: message.content });
      },
    });

    const result = await composer.composeDirect(
      {
        input,
        context,
        intent: {
          type: "casual_chat",
          confidence: 1,
          requiresPlanning: false,
          requiresTool: false,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [],
          reason: "test",
        },
      },
      new AbortController().signal,
    );

    expect(result.content).toBe("hello there");
    expect(savedMessages).toEqual([
      expect.objectContaining({ id: result.messageId, content: "hello there" }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "agent.response.started",
      "agent.model.started",
      "agent.model.delta",
      "agent.response.delta",
      "agent.model.delta",
      "agent.response.delta",
      "agent.model.completed",
    ]);
    expect(events[0]).toMatchObject({
      type: "agent.response.started",
      payload: expect.objectContaining({
        runId: input.runId,
        conversationId: input.conversationId,
        messageId: result.messageId,
      }),
    });
    expect(events[1]).toMatchObject({
      type: "agent.model.started",
      payload: expect.objectContaining({
        runId: input.runId,
        provider: "test.provider",
        model: "test-model",
      }),
    });
    expect(events.at(-1)).toMatchObject({
      type: "agent.model.completed",
      payload: expect.objectContaining({
        runId: input.runId,
        inputTokens: expect.any(Number),
        outputTokens: expect.any(Number),
      }),
    });
    const responseMessageIds = events
      .filter(
        (event) =>
          event.type === "agent.response.started" ||
          event.type === "agent.response.delta",
      )
      .map((event) => (event.payload as { messageId: string }).messageId);
    expect(new Set(responseMessageIds)).toEqual(new Set([result.messageId]));
  });

  test("records and emits model failures", async () => {
    const eventBus = new InMemoryAgentEventBus();
    const events: AgentEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const database = new InMemoryDatabaseContext();
    const savedMessages: Array<{ id: string; content: string }> = [];

    const composer = new ResponseComposer({
      llm: {
        id: "test.provider",
        model: "test-model",
        async *streamChat() {
          yield { delta: "partial" };
          throw Object.assign(new Error("model unavailable"), {
            code: "MODEL_UNAVAILABLE",
            category: "provider",
            retryable: true,
          });
        },
      },
      eventBus,
      modelCalls: database.modelCalls,
      saveMessage: async (message) => {
        savedMessages.push({ id: message.id, content: message.content });
      },
    });

    await expect(
      composer.composeDirect(
        {
          input,
          context,
          intent: {
            type: "casual_chat",
            confidence: 1,
            requiresPlanning: false,
            requiresTool: false,
            requiresApproval: false,
            riskLevel: "low",
            candidateSkills: [],
            reason: "test",
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("model unavailable");

    // Model call persistence is now handled by ModelRouter (§P1-5)
    // ResponseComposer only emits lifecycle events
    expect(events.at(-1)).toMatchObject({
      type: "agent.model.failed",
      payload: expect.objectContaining({
        runId: input.runId,
        modelCallId: expect.any(String),
        error: expect.objectContaining({
          code: "MODEL_UNAVAILABLE",
          message: "model unavailable",
        }),
      }),
    });
    expect(savedMessages).toEqual([
      expect.objectContaining({
        content: "partial\n\n[Response interrupted]",
      }),
    ]);
  });
});
