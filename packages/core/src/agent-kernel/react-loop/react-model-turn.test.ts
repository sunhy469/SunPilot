import { describe, expect, test } from "vitest";
import { InMemoryAgentEventBus } from "../agent-event-bus.js";
import { ReactModelTurn } from "./react-model-turn.js";

describe("ReactModelTurn", () => {
  test("returns a plain-text final and emits model lifecycle events", async () => {
    const { turn, events } = createTurn([{ delta: "hello", raw: {} }]);
    const result = await turn.run(baseInput(), new AbortController().signal);

    expect(result).toEqual(expect.objectContaining({
      text: "hello",
      toolCalls: [],
      finishReason: "stop",
    }));
    expect(events.map((event) => event.type)).toEqual([
      "agent.model.started",
      "agent.model.delta",
      "agent.model.completed",
    ]);
  });

  test("aggregates native tool-call argument deltas alongside progress text", async () => {
    const { turn } = createTurn([
      {
        delta: "checking",
        toolCalls: [{
          index: 0,
          id: "call_1",
          type: "function" as const,
          function: { name: "search", arguments: '{"query":' },
        }],
        raw: {},
      },
      {
        delta: "",
        toolCalls: [{
          index: 0,
          type: "function" as const,
          function: { arguments: '"shirt"}' },
        }],
        raw: {},
      },
    ]);
    const result = await turn.run(baseInput(), new AbortController().signal);

    expect(result.text).toBe("checking");
    expect(result.toolCalls).toEqual([{
      id: "call_1",
      type: "function",
      function: { name: "search", arguments: '{"query":"shirt"}' },
    }]);
    expect(result.finishReason).toBe("tool_calls");
  });

  test("reports malformed function output for an Observation retry", async () => {
    const { turn } = createTurn([{
      delta: "<FunctionCallBegin>not-json<FunctionCallEnd>",
      raw: {},
    }]);
    const result = await turn.run(baseInput(), new AbortController().signal);

    expect(result.toolCalls).toEqual([]);
    expect(result.protocolError).toBe("malformed textual function call");
  });

  test("reports non-success provider finish reasons as protocol errors", async () => {
    const { turn } = createTurn([{
      delta: "partial",
      finishReason: "length",
      raw: {},
    }]);

    const result = await turn.run(baseInput(), new AbortController().signal);

    expect(result.protocolError).toBe("model stopped with finish_reason 'length'");
  });

  test("parses textual function markers split across chunks without leaking them", async () => {
    const { turn } = createTurn([
      { delta: "Looking it up <FunctionCall", raw: {} },
      { delta: "Begin>[{\"name\":\"search\",\"parameters\":{\"query\":\"shirt\"}}]", raw: {} },
      { delta: "<FunctionCallEnd> trailing", raw: {} },
    ]);

    const result = await turn.run(baseInput(), new AbortController().signal);

    expect(result.text).toBe("Looking it up  trailing");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        function: { name: "search", arguments: '{"query":"shirt"}' },
      }),
    ]);
    expect(result.protocolError).toBeUndefined();
  });

  test("deduplicates malformed native tool_call ids before building the transcript", async () => {
    const { turn } = createTurn([{
      delta: "",
      toolCalls: [
        {
          index: 0,
          id: "duplicate_id",
          type: "function" as const,
          function: { name: "search", arguments: '{"query":"a"}' },
        },
        {
          index: 1,
          id: "duplicate_id",
          type: "function" as const,
          function: { name: "search", arguments: '{"query":"b"}' },
        },
      ],
      raw: {},
    }]);

    const result = await turn.run(baseInput(), new AbortController().signal);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.protocolError).toBe("duplicate native tool_call_id");
  });

  test("reserves the configured output budget for a no-tool finalization turn", async () => {
    const { turn, requests } = createTurn([{ delta: "summary", raw: {} }]);

    await turn.run({
      ...baseInput(),
      disableTools: true,
      maxTokens: 321,
      textRole: "final",
    }, new AbortController().signal);

    expect(requests[0]).toEqual(expect.objectContaining({
      maxTokens: 321,
      tool_choice: "none",
      tools: undefined,
    }));
  });

  test("emits a failed event and preserves abort errors", async () => {
    const eventBus = new InMemoryAgentEventBus();
    const events: string[] = [];
    eventBus.subscribe((event) => events.push(event.type));
    const modelRouter = {
      async *streamChat() {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    };
    const turn = new ReactModelTurn({ modelRouter: modelRouter as never, eventBus });

    await expect(turn.run(baseInput(), new AbortController().signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["agent.model.started", "agent.model.failed"]);
  });
});

function baseInput() {
  return {
    runId: "run_1",
    conversationId: "conv_1",
    messages: [{ role: "user" as const, content: "hello" }],
    tools: [{
      type: "function" as const,
      function: {
        name: "search",
        description: "search",
        parameters: { type: "object" },
      },
    }],
    textRole: "progress" as const,
  };
}

function createTurn(chunks: Array<Record<string, unknown>>) {
  const eventBus = new InMemoryAgentEventBus();
  const events: Array<{ type: string }> = [];
  eventBus.subscribe((event) => events.push({ type: event.type }));
  const requests: unknown[] = [];
  const modelRouter = {
    async *streamChat(_purpose: unknown, request: unknown) {
      requests.push(request);
      for (const chunk of chunks) yield chunk;
    },
  };
  return {
    turn: new ReactModelTurn({ modelRouter: modelRouter as never, eventBus }),
    events,
    requests,
  };
}
