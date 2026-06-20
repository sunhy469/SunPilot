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
  const liveEventBus = new InMemoryAgentEventBus();
  // Bridge raw → live (simulates the persist subscriber in composition-root).
  // Uses an async listener to mirror the real RepositoryAgentEventSink.persist()
  // behaviour — this is fire-and-forget by the bus, so without flush() the
  // publish to liveEventBus could race with unsubLive() in handleChatCommand.
  let syntheticSequence = 0;
  eventBus.subscribe(async (event) => {
    // Simulate async DB persist delay (at least one microtick).
    await new Promise((resolve) => setTimeout(resolve, 0));
    liveEventBus.publish({
      ...event,
      sequence: event.sequence ?? ++syntheticSequence,
    });
  });
  const conversations = new InMemoryAgentConversationStore();
  const run =
    overrides.run ??
    (async (input) => {
      const messageId = `msg_assistant_${input.runId}`;
      const partId = "part_text_test";
      eventBus.emit(
        "agent.message.started",
        { runId: input.runId, conversationId: input.conversationId, messageId },
        { runId: input.runId, conversationId: input.conversationId },
      );
      eventBus.emit(
        "agent.message.part.delta",
        {
          runId: input.runId,
          conversationId: input.conversationId,
          messageId,
          partId,
          delta: "hello from ",
        },
        { runId: input.runId, conversationId: input.conversationId },
      );
      eventBus.emit(
        "agent.message.part.delta",
        {
          runId: input.runId,
          conversationId: input.conversationId,
          messageId,
          partId,
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
    liveEventBus,
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

  return { service, conversations, eventBus, liveEventBus };
}

describe("AgentService", () => {
  test("handleChatCommand creates conversation and runs Agent Loop", async () => {
    const { service, conversations } = createService();
    const events: string[] = [];

    const response = await service.handleChatCommand(
      { message: "hello", mode: "agent" },
      { source: "api" },
      {
        onUserMessage(message) {
          events.push(`user:${message.content}`);
        },
        onDelta(delta) {
          events.push(`delta:${delta.delta}`);
        },
      },
    );

    expect(response.conversationId).toMatch(/^conv_/);
    expect(response.runId).toMatch(/^run_/);
    await expect(
      conversations.listMessages(response.conversationId),
    ).resolves.toEqual([
      expect.objectContaining({ role: "user", content: "hello" }),
    ]);
    expect(events).toEqual([
      "user:hello",
      "delta:hello from ",
      "delta:agent loop",
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

  test("assertConversationExists rejects unknown conversations", async () => {
    const { service } = createService();

    await expect(
      service.assertConversationExists("conv_missing"),
    ).rejects.toThrow("Unknown conversation: conv_missing");
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

  test("normal agent.* events delivered via onEvent carry a real sequence (> 0)", async () => {
    const observed: Array<{ type: string; sequence: number }> = [];
    const { service } = createService();

    await service.handleChatCommand(
      { message: "seq check" },
      { source: "api" },
      {
        onEvent(event) {
          observed.push({
            type: event.type,
            sequence: event.sequence ?? -1,
          });
        },
      },
    );

    // Every normal (non-error) agent.* event must have a real sequence.
    const normal = observed.filter((e) => e.type !== "agent.error");
    expect(normal.length).toBeGreaterThan(0);
    for (const e of normal) {
      expect(
        e.sequence,
        `event ${e.type} should have sequence > 0, got ${e.sequence}`,
      ).toBeGreaterThan(0);
    }
  });

  test("handleChatCommand does not miss live events when persist bridge is slow", async () => {
    // This test simulates a slow async persist bridge (the real race condition).
    // The bridge delays each publish by several ticks; flush() must wait for
    // all pending persists before unsubLive(), otherwise events are lost.
    const { service, eventBus, liveEventBus } = createService();
    let resolveBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resolveBarrier = resolve;
    });

    // Install a second, slower async listener on raw eventBus to simulate
    // a persist that takes longer than the loop.
    eventBus.subscribe(async (event) => {
      await barrier; // held until we release it
      liveEventBus.publish({
        ...event,
        sequence: event.sequence ?? 999,
        type: `slow.${event.type}` as any,
      });
    });

    const onEventCalls: Array<{ type: string }> = [];
    let handleResolved = false;

    const handlePromise = service
      .handleChatCommand(
        { message: "slow persist" },
        { source: "web" },
        {
          onEvent(event) {
            onEventCalls.push({ type: event.type });
          },
        },
      )
      .then((result) => {
        handleResolved = true;
        return result;
      });

    // Let the loop finish and flush() start waiting.
    // The slow listener is blocked on the barrier, so flush() will not
    // resolve until we release it.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // handleChatCommand should NOT have resolved yet — it's waiting in flush()
    // for the slow persist bridge to complete.
    expect(handleResolved).toBe(false);

    // Release the slow persist.
    resolveBarrier();
    const response = await handlePromise;

    expect(response.status).toBe("completed");
    // The slow-published events should have been delivered before handleChatCommand returned.
    const slowEvents = onEventCalls.filter((e) => e.type.startsWith("slow."));
    expect(slowEvents.length).toBeGreaterThan(0);
  });

  test("handleChatCommand rejects 1688 search without image attachments", async () => {
    const { service, conversations } = createService();
    await conversations.createConversation({ id: "conv_img" });

    await expect(
      service.handleChatCommand(
        {
          conversationId: "conv_img",
          message: "帮我用1688搜索这件衣服的同款",
          attachments: [], // no image attachments
        },
        { source: "web" },
      ),
    ).rejects.toMatchObject({
      code: "IMAGE_ATTACHMENT_REQUIRED",
      message: "搜索 1688 货源需要上传商品图片，请先上传图片后再试。",
    });
  });

  test("handleChatCommand rejects image search when attachments lack url/dataUrl/storageKey", async () => {
    const { service, conversations } = createService();
    await conversations.createConversation({ id: "conv_img2" });

    await expect(
      service.handleChatCommand(
        {
          conversationId: "conv_img2",
          message: "帮我搜同款货源",
          attachments: [
            {
              id: "att_1",
              name: "photo.jpg",
              type: "image/jpeg",
              // missing url, dataUrl, and storageKey
            },
          ],
        },
        { source: "web" },
      ),
    ).rejects.toMatchObject({
      code: "IMAGE_ATTACHMENT_REF_MISSING",
      message: "图片尚未上传完成，缺少可用的图片链接。请等待上传完成后再试。",
    });
  });

  test("handleChatCommand preserves dataUrl and full attachment fields in persisted message", async () => {
    const { service, conversations } = createService();
    await conversations.createConversation({ id: "conv_attach" });

    const response = await service.handleChatCommand(
      {
        conversationId: "conv_attach",
        message: "搜索同款",
        attachments: [
          {
            id: "att_full",
            name: "test.png",
            type: "image/png",
            sizeBytes: 1024,
            url: "https://oss.example.com/test.png",
            dataUrl: "data:image/png;base64,abc123",
            storageKey: "uploads/test.png",
            provider: "aliyun-oss",
            checksum: "sha256:def456",
          },
        ],
      },
      { source: "web" },
    );

    const messages = await conversations.listMessages(response.conversationId);
    const userMsg = messages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg!.attachments).toEqual([
      {
        id: "att_full",
        name: "test.png",
        type: "image/png",
        sizeBytes: 1024,
        url: "https://oss.example.com/test.png",
        dataUrl: "data:image/png;base64,abc123",
        storageKey: "uploads/test.png",
        provider: "aliyun-oss",
        checksum: "sha256:def456",
      },
    ]);
  });

  test("onDelta receives delta events via raw eventBus without waiting for persist", async () => {
    // Verify that delta streaming is low-latency: deltas arrive during
    // loop execution via the raw eventBus, not after persist.
    const deltas: string[] = [];
    const { service } = createService();

    await service.handleChatCommand(
      { message: "stream deltas" },
      { source: "api" },
      {
        onDelta(delta) {
          deltas.push(delta.delta);
        },
      },
    );

    expect(deltas).toEqual(["hello from ", "agent loop"]);
  });

  // ── §P0-1: reject() must emit run terminal events ────────────────

  test("reject with interrupt strategy emits agent.run.interrupted", async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const { service, eventBus } = createService({
      approvalDecisionService: {
        reject: async () => ({
          approvalId: "appr_1",
          runId: "run_interrupt",
          decidedBy: "user_1",
        }),
      } as any,
      runStateManager: {
        getRun: async () => ({
          runId: "run_interrupt",
          conversationId: "conv_1",
          status: "waiting_approval",
          mode: "agent",
          taskState: { gatheredFacts: {} },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        markStatus: async () => ({ status: "interrupted" }),
      } as any,
    });
    eventBus.subscribe((event) => {
      events.push({ type: event.type, payload: event.payload });
    });

    await service.reject("appr_1", "user_1", "not needed", "interrupt");

    const terminalEvents = events.filter(
      (e) => e.type === "agent.run.interrupted",
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]!.payload).toMatchObject({
      runId: "run_interrupt",
      reason: "not needed",
    });
  });

  test("reject with cancel strategy emits agent.run.cancelled", async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const { service, eventBus } = createService({
      approvalDecisionService: {
        reject: async () => ({
          approvalId: "appr_2",
          runId: "run_cancel",
          decidedBy: "user_1",
        }),
      } as any,
      runStateManager: {
        getRun: async () => ({
          runId: "run_cancel",
          conversationId: "conv_1",
          status: "waiting_approval",
          mode: "agent",
          taskState: { gatheredFacts: {} },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        markCancelled: async (runId: string) => ({
          runId,
          conversationId: "conv_1",
          status: "cancelled",
          mode: "agent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      } as any,
    });
    eventBus.subscribe((event) => {
      events.push({ type: event.type, payload: event.payload });
    });

    await service.reject("appr_2", "user_1", "cancel it", "cancel");

    const terminalEvents = events.filter(
      (e) => e.type === "agent.run.cancelled",
    );
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]!.payload).toMatchObject({
      runId: "run_cancel",
      reason: "cancel it",
    });
  });

  test("reject with continue_without_tool updates status part to completed", async () => {
    const events: Array<{ type: string; payload: unknown }> = [];
    const { service, eventBus } = createService({
      approvalDecisionService: {
        reject: async () => ({
          approvalId: "appr_3",
          runId: "run_continue",
          decidedBy: "user_1",
        }),
      } as any,
      runStateManager: {
        getRun: async () => ({
          runId: "run_continue",
          conversationId: "conv_1",
          status: "waiting_approval",
          mode: "agent",
          taskState: {
            gatheredFacts: {
              approvalMessageId: "msg_1",
              partsSnapshot: [
                { id: "status_1", type: "status", status: "running", label: "等待确认: searchTool" },
              ],
            },
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        markStatus: async () => ({ status: "responding" }),
      } as any,
      loopEngine: {
        continueAfterRejection: async () => ({
          runId: "run_continue",
          conversationId: "conv_1",
          status: "completed",
          artifacts: [],
          toolCalls: [],
        }),
      } as any,
    });
    eventBus.subscribe((event) => {
      events.push({ type: event.type, payload: event.payload });
    });

    await service.reject("appr_3", "user_1", "skip tool", "continue_without_tool");

    const partUpdated = events.filter(
      (e) => e.type === "agent.message.part.updated",
    );
    expect(partUpdated.length).toBeGreaterThanOrEqual(1);
    expect(partUpdated[0]!.payload).toMatchObject({
      partId: "status_1",
      patch: {
        status: "completed",
        label: expect.stringContaining("已拒绝"),
      },
    });
  });
});
