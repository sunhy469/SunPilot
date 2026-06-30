import { describe, expect, test, vi } from "vitest";
import { InMemoryAgentEventBus } from "../agent-event-bus.js";
import { AssistantMessageStream } from "../assistant-message-stream.js";
import type {
  AgentContext,
  AgentLoopInput,
  IAssistantMessageStream,
} from "../loop-types.js";
import { ToolCatalogRetriever } from "../tools/tool-catalog-retriever.js";
import type { SkillSummary } from "../tools/tool-types.js";
import { ObservationBuilder } from "./observation-builder.js";
import { ReactLoopRunner } from "./react-loop-runner.js";
import { ToolCallGuard } from "./tool-call-guard.js";

const agentInput: AgentLoopInput = {
  runId: "run_react",
  conversationId: "conv_react",
  userMessageId: "msg_user",
  message: "search for a product",
  mode: "agent",
  permissionMode: "auto",
  client: { source: "web" },
};

const context: AgentContext = {
  runId: agentInput.runId,
  conversationId: agentInput.conversationId,
  system: { persona: "You are SunPilot.", rules: [], safety: [] },
  currentMessage: {
    id: agentInput.userMessageId,
    content: agentInput.message,
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

const searchSkill: SkillSummary = {
  id: "test:search",
  name: "Product search",
  description: "Search products by query",
  category: "web",
  enabled: true,
  permissions: ["network.request"],
  defaultTimeoutMs: 1_000,
  maxTimeoutMs: 5_000,
  supportsAbort: true,
  idempotent: true,
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: { query: { type: "string" } },
  },
  riskHints: { defaultRisk: "low" },
};

describe("ReactLoopRunner", () => {
  test("uses the first LLM turn for a no-tool final answer", async () => {
    const model = scriptedModel([{ text: "直接回答", toolCalls: [] }]);
    const { runner, stream, checkpoints, executor } = createRunner(model);

    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.content).toBe("直接回答");
    }
    expect(model.run).toHaveBeenCalledTimes(1);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(checkpoints.at(-1)?.modelCalls).toBe(1);
    expect(checkpoints.at(-1)?.partsSnapshot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          semanticRole: "final",
          content: "直接回答",
        }),
      ]),
    );
  });

  test("includes prior observations and artifacts without emitting orphan tool roles", async () => {
    const model = scriptedModel([{ text: "context aware", toolCalls: [] }]);
    const { runner, stream } = createRunner(model);
    const enrichedContext: AgentContext = {
      ...context,
      messages: [{ role: "tool", content: "legacy tool content" }],
      toolResults: [{
        toolCallId: "old_call",
        summary: "old summary",
        content: "old external content",
        status: "completed",
      }],
      artifacts: [{
        id: "artifact_1",
        name: "report.md",
        type: "text",
        summary: "existing report",
      }],
    };

    await runner.run(
      { agentInput, context: enrichedContext, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    const messages = model.run.mock.calls[0]![0].messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.some((message) => message.role === "tool")).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("old external content"),
      }),
      expect.objectContaining({
        role: "system",
        content: expect.stringContaining("artifact_1"),
      }),
    ]));
  });

  test("feeds a tool observation back to the LLM before finalizing", async () => {
    const model = scriptedModel([
      {
        text: "我先搜索。",
        toolCalls: [toolCall("call_1", { query: "shirt" })],
      },
      { text: "找到结果。", toolCalls: [] },
    ]);
    const { runner, stream, executor } = createRunner(model);

    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.content).toBe("找到结果。");
    }
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const secondTurn = model.run.mock.calls[1]![0] as {
      messages: Array<{ role: string; tool_call_id?: string }>;
    };
    expect(secondTurn.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "call_1" }),
      ]),
    );
  });

  test("turns invalid arguments into an observation instead of executing", async () => {
    const model = scriptedModel([
      { text: "", toolCalls: [toolCall("call_bad", {})] },
      { text: "请补充搜索词。", toolCalls: [] },
    ]);
    const { runner, stream, executor } = createRunner(model);

    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    expect(executor.execute).not.toHaveBeenCalled();
    const secondTurn = model.run.mock.calls[1]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondTurn.messages.some((message) =>
      message.role === "tool" && message.content.includes("validation failed"),
    )).toBe(true);
  });

  test("persists the empty-final fallback in the transcript checkpoint", async () => {
    const model = scriptedModel([{ text: "", toolCalls: [] }]);
    const { runner, stream } = createRunner(model);

    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    if (result.type === "completed") {
      expect(result.content).toBe("本次模型没有返回可用内容，请重试。");
      expect(result.checkpoint.transcript.at(-1)).toEqual(expect.objectContaining({
        role: "assistant",
        content: "本次模型没有返回可用内容，请重试。",
      }));
    }
  });

  test("suspends through the request-input control tool", async () => {
    const model = scriptedModel([
      {
        text: "",
        toolCalls: [{
          id: "ask_1",
          type: "function",
          function: {
            name: "agent_request_input",
            arguments: JSON.stringify({
              question: "要搜索什么商品？",
              missingFields: ["query"],
            }),
          },
        }],
      },
    ]);
    const { runner, stream } = createRunner(model);
    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result).toEqual(expect.objectContaining({
      type: "waiting_user",
      question: "要搜索什么商品？",
      missingFields: ["query"],
    }));
  });

  test("freezes an approval-gated action without executing it", async () => {
    const dangerousSkill: SkillSummary = {
      ...searchSkill,
      id: "test:delete",
      name: "Delete resource",
      permissions: ["filesystem.delete"],
      riskHints: { defaultRisk: "high" },
    };
    const model = scriptedModel([
      {
        text: "",
        toolCalls: [{
          id: "call_delete",
          type: "function",
          function: {
            name: "test_delete",
            arguments: JSON.stringify({ query: "target" }),
          },
        }],
      },
    ]);
    const { runner, stream, executor } = createRunner(model, [dangerousSkill]);
    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("waiting_approval");
    expect(executor.execute).not.toHaveBeenCalled();
    if (result.type === "waiting_approval") {
      expect(result.checkpoint.pendingToolCalls[0]?.id).toBe("call_delete");
    }
  });

  test("supports chained and parallel native tool actions", async () => {
    const model = scriptedModel([
      { text: "", toolCalls: [toolCall("call_a", { query: "a" })] },
      {
        text: "",
        toolCalls: [
          toolCall("call_b", { query: "b" }),
          toolCall("call_c", { query: "c" }),
        ],
      },
      { text: "done", toolCalls: [] },
    ]);
    const { runner, stream, executor } = createRunner(model);

    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(executor.execute.mock.calls[1]![0].calls).toHaveLength(2);
    expect(model.run).toHaveBeenCalledTimes(3);
  });

  test("lets the model repair invalid arguments in the same loop", async () => {
    const model = scriptedModel([
      { text: "", toolCalls: [toolCall("bad", {})] },
      { text: "", toolCalls: [toolCall("fixed", { query: "shirt" })] },
      { text: "repaired", toolCalls: [] },
    ]);
    const { runner, stream, executor } = createRunner(model);

    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute.mock.calls[0]![0].calls[0].id).toBe("fixed");
  });

  test("feeds tool failure back so the model can switch tools", async () => {
    const backupSkill: SkillSummary = {
      ...searchSkill,
      id: "test:backup",
      name: "Backup search",
    };
    const model = scriptedModel([
      { text: "", toolCalls: [toolCall("primary_failed", { query: "shirt" })] },
      {
        text: "",
        toolCalls: [{
          id: "backup_succeeded",
          type: "function",
          function: {
            name: "test_backup",
            arguments: '{"query":"shirt"}',
          },
        }],
      },
      { text: "used backup", toolCalls: [] },
    ]);
    const harness = createRunner(model, [searchSkill, backupSkill], {
      execute: async ({ calls }) => ({
        summaries: calls.map((call) => ({
          id: call.id,
          skillId: call.skillId,
          name: call.name,
          status: call.id === "primary_failed" ? "failed" as const : "completed" as const,
          summary: call.id === "primary_failed" ? "primary unavailable" : "backup result",
        })),
        artifacts: [],
      }),
    });

    const result = await harness.runner.run(
      { agentInput, context, messageId: "msg_assistant", stream: harness.stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    expect(harness.executor.execute).toHaveBeenCalledTimes(2);
    expect(model.run.mock.calls[1]![0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "primary_failed",
          content: expect.stringContaining("primary unavailable"),
        }),
      ]),
    );
  });

  test("forces one final no-tool turn when the round budget is exhausted", async () => {
    const model = scriptedModel([
      { text: "", toolCalls: [toolCall("call_1", { query: "shirt" })] },
      { text: "budget summary", toolCalls: [] },
    ]);
    const { runner, stream } = createRunner(model, [searchSkill], {
      limits: { maxToolRounds: 1 },
    });

    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    expect(model.run.mock.calls[1]![0]).toEqual(
      expect.objectContaining({
        disableTools: true,
        textRole: "final",
        maxTokens: 1_000,
      }),
    );
  });

  test("resumes approval, rejection, and user input on the same transcript", async () => {
    const dangerousSkill: SkillSummary = {
      ...searchSkill,
      id: "test:delete",
      name: "Delete resource",
      permissions: ["filesystem.delete"],
      riskHints: { defaultRisk: "high" },
    };
    const approvalModel = scriptedModel([
      {
        text: "",
        toolCalls: [{
          id: "delete_1",
          type: "function",
          function: { name: "test_delete", arguments: '{"query":"x"}' },
        }],
      },
      { text: "approved final", toolCalls: [] },
    ]);
    const approvalHarness = createRunner(approvalModel, [dangerousSkill]);
    const waiting = await approvalHarness.runner.run(
      { agentInput, context, messageId: "msg_assistant", stream: approvalHarness.stream },
      new AbortController().signal,
    );
    expect(waiting.type).toBe("waiting_approval");
    if (waiting.type !== "waiting_approval") throw new Error("expected approval");

    const approved = await approvalHarness.runner.resumeAfterApprovedTools({
      agentInput,
      context,
      checkpoint: waiting.checkpoint,
      stream: approvalHarness.stream,
      approvedTools: [{
        toolCallId: "delete_1",
        skillId: "test:delete",
        arguments: { query: "x" },
      }],
    }, new AbortController().signal);
    expect(approved.type).toBe("completed");
    expect(approvalModel.run.mock.calls[1]![0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "delete_1" }),
      ]),
    );

    const rejectionModel = scriptedModel([{ text: "alternative", toolCalls: [] }]);
    const rejectionHarness = createRunner(rejectionModel, [dangerousSkill]);
    const rejected = await rejectionHarness.runner.resumeAfterRejection({
      agentInput,
      context,
      checkpoint: waiting.checkpoint,
      stream: rejectionHarness.stream,
      reason: "no",
    }, new AbortController().signal);
    expect(rejected.type).toBe("completed");
    expect(rejectionModel.run.mock.calls[0]![0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", content: expect.stringContaining("rejected") }),
      ]),
    );

    const askModel = scriptedModel([
      {
        text: "",
        toolCalls: [{
          id: "ask_1",
          type: "function",
          function: {
            name: "agent_request_input",
            arguments: '{"question":"query?","missingFields":["query"]}',
          },
        }],
      },
      { text: "input final", toolCalls: [] },
    ]);
    const askHarness = createRunner(askModel);
    const asked = await askHarness.runner.run(
      { agentInput, context, messageId: "msg_assistant", stream: askHarness.stream },
      new AbortController().signal,
    );
    expect(asked.type).toBe("waiting_user");
    if (asked.type !== "waiting_user") throw new Error("expected user input");
    await askHarness.runner.resumeWithUserInput({
      agentInput,
      context,
      checkpoint: asked.checkpoint,
      stream: askHarness.stream,
      userMessage: "shoes",
    }, new AbortController().signal);
    expect(askModel.run.mock.calls[1]![0].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "user", content: "shoes" })]),
    );
  });

  test("resumes an interrupted checkpoint without replaying an unresolved action", async () => {
    const model = scriptedModel([{ text: "safe recovery", toolCalls: [] }]);
    const { runner, stream, executor } = createRunner(model);
    const interrupted = {
      version: 1 as const,
      runId: agentInput.runId,
      conversationId: agentInput.conversationId,
      messageId: "msg_assistant",
      iteration: 0,
      modelCalls: 1,
      transcript: [{
        role: "assistant" as const,
        content: "",
        tool_calls: [toolCall("uncertain", { query: "x" })],
      }],
      candidateToolIds: [searchSkill.id],
      pendingToolCalls: [],
      artifacts: [],
      toolCallSummaries: [],
      partsSnapshot: [],
      permissionMode: "auto" as const,
      updatedAt: new Date().toISOString(),
    };

    const result = await runner.resumeInterrupted(
      { agentInput, context, checkpoint: interrupted, stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    expect(executor.execute).not.toHaveBeenCalled();
    expect(model.run.mock.calls[0]![0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "uncertain",
          content: expect.stringContaining("outcome is unknown"),
        }),
      ]),
    );
  });

  test("honors cancellation before the first model turn", async () => {
    const model = scriptedModel([{ text: "unused", toolCalls: [] }]);
    const { runner, stream } = createRunner(model);
    const controller = new AbortController();
    controller.abort();

    await expect(runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(model.run).not.toHaveBeenCalled();
  });

  test("stops after cancellation during tool execution", async () => {
    const controller = new AbortController();
    const model = scriptedModel([
      { text: "", toolCalls: [toolCall("cancel_tool", { query: "shirt" })] },
    ]);
    const harness = createRunner(model, [searchSkill], {
      execute: async ({ calls }) => {
        controller.abort();
        return {
          summaries: calls.map((call) => ({
            id: call.id,
            skillId: call.skillId,
            name: call.name,
            status: "cancelled" as const,
            summary: "cancelled",
          })),
          artifacts: [],
        };
      },
    });

    await expect(harness.runner.run(
      { agentInput, context, messageId: "msg_assistant", stream: harness.stream },
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(model.run).toHaveBeenCalledTimes(1);
  });

  test("closes native tool calls before retrying a model protocol error", async () => {
    const model = scriptedModel([
      {
        text: "",
        toolCalls: [toolCall("partial_batch", { query: "shirt" })],
        protocolError: "incomplete native tool-call delta",
      },
      { text: "recovered", toolCalls: [] },
    ]);
    const { runner, stream, executor } = createRunner(model);

    const result = await runner.run(
      { agentInput, context, messageId: "msg_assistant", stream },
      new AbortController().signal,
    );

    expect(result.type).toBe("completed");
    expect(executor.execute).not.toHaveBeenCalled();
    expect(model.run.mock.calls[1]![0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "partial_batch" }),
      ]),
    );
  });

  test("returns malformed or mixed request-input actions to the model", async () => {
    const ask = (id: string, argumentsValue: string) => ({
      id,
      type: "function" as const,
      function: { name: "agent_request_input", arguments: argumentsValue },
    });
    const malformedModel = scriptedModel([
      { text: "", toolCalls: [ask("ask_bad", "{")] },
      { text: "fixed", toolCalls: [] },
    ]);
    const malformedHarness = createRunner(malformedModel);
    const malformed = await malformedHarness.runner.run(
      {
        agentInput,
        context,
        messageId: "msg_assistant",
        stream: malformedHarness.stream,
      },
      new AbortController().signal,
    );
    expect(malformed.type).toBe("completed");
    expect(malformedModel.run.mock.calls[1]![0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "ask_bad" }),
      ]),
    );

    const mixedModel = scriptedModel([
      {
        text: "",
        toolCalls: [
          ask("ask_mixed", '{"question":"query?"}'),
          toolCall("call_mixed", { query: "shirt" }),
        ],
      },
      { text: "fixed mixed batch", toolCalls: [] },
    ]);
    const mixedHarness = createRunner(mixedModel);
    const mixed = await mixedHarness.runner.run(
      { agentInput, context, messageId: "msg_assistant", stream: mixedHarness.stream },
      new AbortController().signal,
    );
    expect(mixed.type).toBe("completed");
    expect(mixedHarness.executor.execute).not.toHaveBeenCalled();
    expect(mixedModel.run.mock.calls[1]![0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "ask_mixed" }),
        expect.objectContaining({ role: "tool", tool_call_id: "call_mixed" }),
      ]),
    );
  });

  test("re-retrieves tools after user input on the same transcript", async () => {
    const model = scriptedModel([
      {
        text: "",
        toolCalls: [{
          id: "ask_refresh",
          type: "function",
          function: {
            name: "agent_request_input",
            arguments: '{"question":"query?"}',
          },
        }],
      },
      { text: "done", toolCalls: [] },
    ]);
    const retriever = new ToolCatalogRetriever();
    const retrieve = vi.spyOn(retriever, "retrieve");
    const harness = createRunner(model, [searchSkill], { retriever });
    const waiting = await harness.runner.run(
      { agentInput, context, messageId: "msg_assistant", stream: harness.stream },
      new AbortController().signal,
    );
    if (waiting.type !== "waiting_user") throw new Error("expected waiting_user");

    await harness.runner.resumeWithUserInput({
      agentInput: { ...agentInput, message: "shoes" },
      context: {
        ...context,
        currentMessage: { ...context.currentMessage, content: "shoes" },
      },
      checkpoint: waiting.checkpoint,
      stream: harness.stream,
      userMessage: "shoes",
    }, new AbortController().signal);

    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve.mock.calls[1]![0].query).toBe("shoes");
  });

  test("rejects an approval payload that differs from the frozen batch", async () => {
    const dangerousSkill: SkillSummary = {
      ...searchSkill,
      id: "test:delete",
      name: "Delete resource",
      permissions: ["filesystem.delete"],
      riskHints: { defaultRisk: "high" },
    };
    const model = scriptedModel([{
      text: "",
      toolCalls: [{
        id: "delete_scope",
        type: "function",
        function: { name: "test_delete", arguments: '{"query":"x"}' },
      }],
    }]);
    const harness = createRunner(model, [dangerousSkill]);
    const waiting = await harness.runner.run(
      { agentInput, context, messageId: "msg_assistant", stream: harness.stream },
      new AbortController().signal,
    );
    if (waiting.type !== "waiting_approval") throw new Error("expected approval");

    await expect(harness.runner.resumeAfterApprovedTools({
      agentInput,
      context,
      checkpoint: waiting.checkpoint,
      stream: harness.stream,
      approvedTools: [{
        toolCallId: "delete_scope",
        skillId: "test:delete",
        arguments: { query: "tampered" },
      }],
    }, new AbortController().signal)).rejects.toMatchObject({
      code: "AGENT_APPROVAL_SCOPE_MISMATCH",
    });
    expect(harness.executor.execute).not.toHaveBeenCalled();
  });

  test("does not call the model again after the wall-clock deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const model = scriptedModel([
        { text: "", toolCalls: [toolCall("deadline_call", { query: "shirt" })] },
        { text: "must not run", toolCalls: [] },
      ], () => vi.setSystemTime(2_000));
      const { runner, stream } = createRunner(model, [searchSkill], {
        limits: { maxWallClockMs: 1_000 },
      });

      await expect(runner.run(
        { agentInput, context, messageId: "msg_assistant", stream },
        new AbortController().signal,
      )).rejects.toMatchObject({ code: "AGENT_REACT_DEADLINE_EXCEEDED" });
      expect(model.run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createRunner(
  model: ReturnType<typeof scriptedModel>,
  skills: SkillSummary[] = [searchSkill],
  options?: {
    limits?: Partial<import("./react-types.js").ReactLoopLimits>;
    execute?: (input: { calls: Array<{ id: string; skillId: string; name: string }> }) => Promise<{
      summaries: Array<{
        id: string;
        skillId: string;
        name: string;
        status: "completed" | "failed" | "cancelled" | "timeout";
        summary: string;
        content?: string;
      }>;
      artifacts: [];
    }>;
    retriever?: ToolCatalogRetriever;
  },
) {
  const eventBus = new InMemoryAgentEventBus();
  const checkpoints: Array<import("./react-types.js").ReactCheckpoint> = [];
  const defaultExecute = async (input: { calls: Array<{ id: string; skillId: string; name: string }> }) => ({
      summaries: input.calls.map((call) => ({
        id: call.id,
        skillId: call.skillId,
        name: call.name,
        status: "completed" as const,
        summary: "tool result",
        content: "product A",
      })),
      artifacts: [] as [],
    });
  const executor = {
    execute: vi.fn(options?.execute ?? defaultExecute),
  };
  const observations = new ObservationBuilder(8_000);
  const runner = new ReactLoopRunner({
    listSkills: async () => skills,
    retriever: options?.retriever ?? new ToolCatalogRetriever(),
    modelTurn: model as never,
    guard: new ToolCallGuard({
      async evaluate(input) {
        const skill = skills.find((candidate) => candidate.id === input.skillId)!;
        return {
          allowed: true,
          requiresApproval: skill.riskHints.defaultRisk === "high",
          riskLevel: skill.riskHints.defaultRisk,
          reasons: [],
        };
      },
    }, observations),
    executor: executor as never,
    saveCheckpoint: async (checkpoint) => {
      checkpoints.push(checkpoint);
    },
    limits: options?.limits,
  });
  const stream = new AssistantMessageStream({
    runId: agentInput.runId,
    conversationId: agentInput.conversationId,
    messageId: "msg_assistant",
    eventBus,
    saveMessage: async () => undefined,
  });
  stream.start();
  return { runner, stream, checkpoints, executor };
}

function scriptedModel(
  turns: Array<{
    text: string;
    toolCalls: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
    protocolError?: string;
  }>,
  beforeFirstReturn?: () => void,
) {
  let index = 0;
  return {
    run: vi.fn(async (input: {
      stream?: IAssistantMessageStream;
      textRole: "progress" | "final";
    }) => {
      const turn = turns[index++]!;
      if (index === 1) beforeFirstReturn?.();
      let textPartId: string | undefined;
      if (turn.text && input.stream) {
        const part = input.stream.startTextPart(input.textRole);
        textPartId = part.id;
        input.stream.appendText(part.id, turn.text);
      }
      return {
        text: turn.text,
        toolCalls: turn.toolCalls,
        finishReason: turn.toolCalls.length ? "tool_calls" : "stop",
        textPartId,
        firstTokenMs: 1,
        modelCallId: `model_${index}`,
        protocolError: turn.protocolError,
      };
    }),
  };
}

function toolCall(id: string, args: Record<string, unknown>) {
  return {
    id,
    type: "function" as const,
    function: {
      name: "test_search",
      arguments: JSON.stringify(args),
    },
  };
}
