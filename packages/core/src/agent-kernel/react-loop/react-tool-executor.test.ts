import { describe, expect, test } from "vitest";
import { InMemoryAgentEventBus } from "../agent-event-bus.js";
import { AssistantMessageStream } from "../assistant-message-stream.js";
import type { AgentContext, PlannedToolCall } from "../loop-types.js";
import { ReactToolExecutor } from "./react-tool-executor.js";

describe("ReactToolExecutor", () => {
  test("projects batch observations in the original model-action order", async () => {
    const calls = [planned("call_a"), planned("call_b"), planned("call_c")];
    const eventBus = new InMemoryAgentEventBus();
    const completedEvents: string[] = [];
    eventBus.subscribe((event) => {
      if (event.type === "agent.tool.completed") {
        completedEvents.push((event.payload as { toolCallId: string }).toolCallId);
      }
    });
    const executor = new ReactToolExecutor({
      async execute() {
        for (const call of calls) {
          eventBus.emit("agent.tool.completed", {
            runId: "run_order",
            toolCallId: call.id,
            skillId: call.skillId,
            summary: call.id,
            artifacts: [`artifact_${call.id}`],
          }, { runId: "run_order", conversationId: "conv_order" });
        }
        return {
          runId: "run_order",
          toolCalls: [calls[2], calls[0], calls[1]].map((call) => ({
            id: call!.id,
            skillId: call!.skillId,
            name: call!.name,
            status: "completed" as const,
            summary: call!.id,
            artifactIds: [`artifact_${call!.id}`],
          })),
          artifacts: calls.map((call) => ({
            id: `artifact_${call.id}`,
            name: `${call.id}.txt`,
            type: "text",
          })),
          summary: "done",
        };
      },
    }, eventBus);
    const stream = new AssistantMessageStream({
      runId: "run_order",
      conversationId: "conv_order",
      messageId: "msg_order",
      eventBus,
      saveMessage: async () => undefined,
    });
    stream.start();

    const result = await executor.execute({
      runId: "run_order",
      conversationId: "conv_order",
      context,
      calls,
      permissionMode: "auto",
      stream,
    }, new AbortController().signal);

    expect(result.summaries.map((summary) => summary.id)).toEqual([
      "call_a",
      "call_b",
      "call_c",
    ]);
    expect(completedEvents).toEqual(["call_a", "call_b", "call_c"]);
    expect(stream.getPartsSnapshot().filter((part) => part.type === "tool_result"))
      .toEqual(expect.arrayContaining(calls.map((call) => expect.objectContaining({
        toolCallId: call.id,
        artifactIds: [`artifact_${call.id}`],
      }))));
  });
});

function planned(id: string): PlannedToolCall {
  return {
    id,
    skillId: `test:${id}`,
    name: id,
    arguments: {},
    permissions: [],
    reason: "test",
    riskLevel: "low",
    requiresApproval: false,
    timeoutMs: 1_000,
  };
}

const context: AgentContext = {
  runId: "run_order",
  conversationId: "conv_order",
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: { id: "user_order", content: "test", attachments: [] },
  messages: [],
  memories: [],
  artifacts: [],
  toolResults: [],
  availableSkills: [],
  limits: { maxTokens: 1_000, reservedForOutput: 100, usedTokensEstimate: 1 },
  tokenEstimate: 1,
};
