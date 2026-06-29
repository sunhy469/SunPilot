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
  const modelRouter = {
    async *streamChat() {
      for (const chunk of chunks) yield chunk;
    },
  };
  return {
    turn: new ReactModelTurn({ modelRouter: modelRouter as never, eventBus }),
    events,
  };
}
