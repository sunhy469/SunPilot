import { describe, expect, test } from "vitest";
import { AbortRegistry } from "../agent-kernel/abort-registry.js";
import { InMemoryAgentEventBus } from "../agent-kernel/agent-event-bus.js";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { RepositoryRunStateManager } from "../agent-kernel/persistence/repository-run-state-manager.js";
import { AgentService, type AgentLoopServiceConfig } from "./agent.service.js";
import { InMemoryAgentConversationStore } from "./conversation.service.js";

function createService(
  overrides: Partial<AgentLoopServiceConfig> & {
    run?: AgentLoopServiceConfig["loopEngine"]["run"];
  } = {},
) {
  const eventBus = new InMemoryAgentEventBus();
  const conversations = new InMemoryAgentConversationStore();
  const run =
    overrides.run ??
    (async (input) => {
      const messageId = `msg_assistant_${input.runId}`;
      eventBus.emit(
        "agent.response.started",
        { runId: input.runId, messageId },
        { runId: input.runId, conversationId: input.conversationId },
      );
      eventBus.emit(
        "agent.response.delta",
        {
          runId: input.runId,
          conversationId: input.conversationId,
          messageId,
          delta: "hello from ",
        },
        { runId: input.runId, conversationId: input.conversationId },
      );
      eventBus.emit(
        "agent.response.delta",
        {
          runId: input.runId,
          conversationId: input.conversationId,
          messageId,
          delta: "agent loop",
        },
        { runId: input.runId, conversationId: input.conversationId },
      );
      return {
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId: messageId,
        status: "completed" as const,
        artifacts: [],
        toolCalls: [],
      };
    });

  const service = new AgentService({
    loopEngine: {
      run,
      resumeApprovedTool: async () => {
        throw new Error("not used");
      },
    } as any,
    abortRegistry: new AbortRegistry(),
    eventBus,
    runStateManager: {
      createRun: async () => undefined,
      markCancelled: async (runId: string) => ({
        runId,
        conversationId: "conv_cancel",
        status: "cancelled",
        mode: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      markFailed: async () => undefined,
      getRun: async (runId: string) => ({
        runId,
        conversationId: "conv_cancel",
        status: "cancelled",
        mode: "agent",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    } as any,
    approvalGate: {} as any,
    conversations,
    ...overrides,
  });

  return { service, conversations, eventBus };
}

describe("AgentService", () => {
  test("routes compatibility chat() calls through the Agent Loop", async () => {
    const { service, conversations } = createService();
    const events: string[] = [];

    const response = await service.chat(
      { message: "hello" },
      {
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
        },
      },
    );

    expect(response.conversationId).toMatch(/^conv_/);
    expect(response.message).toMatchObject({
      conversationId: response.conversationId,
      role: "assistant",
      content: "hello from agent loop",
    });
    await expect(
      conversations.listMessages(response.conversationId),
    ).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
    ]);
    expect(events).toEqual([
      "user:hello",
      `started:${response.message.id}`,
      "delta:hello from ",
      "delta:agent loop",
      `assistant:${response.message.id}:hello from agent loop`,
    ]);
  });

  test("handleChatCommand creates a run and forwards Agent response deltas", async () => {
    const observed: string[] = [];
    const { service } = createService();

    const response = await service.handleChatCommand(
      { message: "stream please" },
      { source: "api" },
      {
        onDelta(delta) {
          observed.push(delta.delta);
        },
      },
    );

    expect(response.status).toBe("completed");
    expect(response.runId).toMatch(/^run_/);
    expect(response.messageId).toMatch(/^msg_assistant_/);
    expect(observed).toEqual(["hello from ", "agent loop"]);
  });

  test("rejects unknown conversations before starting the loop", async () => {
    let called = false;
    const { service } = createService({
      run: async () => {
        called = true;
        throw new Error("should not call loop");
      },
    });

    await expect(
      service.chat({ conversationId: "conv_missing", message: "hello" }),
    ).rejects.toThrow("Unknown conversation: conv_missing");
    expect(called).toBe(false);
  });

  test("replays completed chat commands with the same clientRequestId", async () => {
    const db = new InMemoryDatabaseContext();
    let calls = 0;
    const { service, conversations } = createService({
      idempotency: db.idempotency,
      run: async (input) => {
        calls += 1;
        return {
          runId: input.runId,
          conversationId: input.conversationId,
          assistantMessageId: `msg_assistant_${input.runId}`,
          status: "completed",
          artifacts: [],
          toolCalls: [],
        };
      },
    });

    const first = await service.handleChatCommand(
      { message: "dedupe me", clientRequestId: "req_same" },
      { source: "web", userId: "user_1" },
    );
    const second = await service.handleChatCommand(
      { message: "dedupe me", clientRequestId: "req_same" },
      { source: "web", userId: "user_1" },
    );

    expect(second).toEqual(first);
    expect(calls).toBe(1);
    await expect(
      conversations.listMessages(first.conversationId),
    ).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "dedupe me" }),
    ]);
  });

  test("does not replay in-progress chat commands with the same clientRequestId", async () => {
    const db = new InMemoryDatabaseContext();
    let finishRun!: () => void;
    const releaseRun = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const { service } = createService({
      idempotency: db.idempotency,
      run: async (input) => {
        await releaseRun;
        return {
          runId: input.runId,
          conversationId: input.conversationId,
          assistantMessageId: `msg_assistant_${input.runId}`,
          status: "completed",
          artifacts: [],
          toolCalls: [],
        };
      },
    });

    const first = service.handleChatCommand(
      { message: "dedupe me", clientRequestId: "req_processing" },
      { source: "web", userId: "user_1" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      service.handleChatCommand(
        { message: "dedupe me", clientRequestId: "req_processing" },
        { source: "web", userId: "user_1" },
      ),
    ).rejects.toMatchObject({
      code: "AGENT_IDEMPOTENCY_IN_PROGRESS",
      category: "idempotency",
      retryable: true,
    });

    finishRun();
    await expect(first).resolves.toMatchObject({ status: "completed" });
  });

  test("rejects reused clientRequestId with a different payload", async () => {
    const db = new InMemoryDatabaseContext();
    const { service } = createService({ idempotency: db.idempotency });

    await service.handleChatCommand(
      { message: "first", clientRequestId: "req_conflict" },
      { source: "web", userId: "user_1" },
    );

    await expect(
      service.handleChatCommand(
        { message: "second", clientRequestId: "req_conflict" },
        { source: "web", userId: "user_1" },
      ),
    ).rejects.toMatchObject({
      code: "AGENT_IDEMPOTENCY_CONFLICT",
      category: "idempotency",
    });
  });

  test("cancelRun marks an Agent run cancelled and emits canonical event", async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    let cancelledReason = "";
    const { service, eventBus } = createService({
      runStateManager: {
        createRun: async () => undefined,
        markCancelled: async (runId: string, reason?: string) => {
          cancelledReason = reason ?? "";
          return {
            runId,
            conversationId: "conv_cancel",
            status: "cancelled",
            mode: "agent",
            createdAt: "2026-06-06T00:00:00.000Z",
            updatedAt: "2026-06-06T00:00:01.000Z",
          };
        },
        markFailed: async () => undefined,
        getRun: async (runId: string) => ({
          runId,
          conversationId: "conv_cancel",
          status: "cancelled",
          mode: "agent",
          createdAt: "2026-06-06T00:00:00.000Z",
          updatedAt: "2026-06-06T00:00:01.000Z",
        }),
      } as any,
    });
    eventBus.subscribe((event) => {
      events.push({ type: event.type, payload: event.payload });
    });

    await expect(
      service.cancelRun("run_cancel", "user requested"),
    ).resolves.toEqual({
      cancelled: true,
      runId: "run_cancel",
      stopped: false,
    });

    expect(cancelledReason).toBe("user requested");
    expect(events).toEqual([
      {
        type: "agent.run.cancelled",
        payload: { runId: "run_cancel", reason: "user requested" },
      },
    ]);
  });

  test("resumeRun creates a linked Agent attempt for an interrupted run", async () => {
    const db = new InMemoryDatabaseContext();
    const runStateManager = new RepositoryRunStateManager(db);
    const { service, conversations } = createService({
      database: db,
      runStateManager,
      run: async (input) => ({
        runId: input.runId,
        conversationId: input.conversationId,
        assistantMessageId: `msg_assistant_${input.runId}`,
        status: "completed",
        artifacts: [],
        toolCalls: [],
      }),
    });
    await conversations.createConversation({ id: "conv_resume" });
    await db.runs.create({
      id: "run_old",
      title: "Original",
      status: "interrupted",
      mode: "agent",
      conversationId: "conv_resume",
      goal: "continue this task",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
      input: { message: "continue this task" },
      context: {},
    });

    const result = await service.resumeRun("run_old");

    expect(result).toMatchObject({
      resumed: true,
      originalRunId: "run_old",
      conversationId: "conv_resume",
      status: "completed",
    });
    expect(result.runId).not.toBe("run_old");
    await expect(db.runs.findById(result.runId)).resolves.toMatchObject({
      context: expect.objectContaining({
        resumeOf: "run_old",
        attempt: expect.objectContaining({
          action: "resume",
          originalRunId: "run_old",
          originalStatus: "interrupted",
        }),
      }),
    });
    await expect(db.audit.list(result.runId)).resolves.toEqual([
      expect.objectContaining({
        action: "run.resume",
        target: "run_old",
      }),
    ]);
    await expect(db.events.listByRunId(result.runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.run.started",
          payload: expect.objectContaining({
            originalRunId: "run_old",
            attemptAction: "resume",
          }),
        }),
      ]),
    );
  });

  test("resumeRun rejects active or completed runs", async () => {
    const db = new InMemoryDatabaseContext();
    const { service, conversations } = createService({
      database: db,
      runStateManager: new RepositoryRunStateManager(db),
    });
    await conversations.createConversation({ id: "conv_done" });
    await db.runs.create({
      id: "run_done",
      title: "Done",
      status: "completed",
      mode: "agent",
      conversationId: "conv_done",
      goal: "done task",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
      input: { message: "done task" },
      context: {},
    });

    await expect(service.resumeRun("run_done")).rejects.toMatchObject({
      code: "AGENT_RUN_STATE_CONFLICT",
    });
  });
});
