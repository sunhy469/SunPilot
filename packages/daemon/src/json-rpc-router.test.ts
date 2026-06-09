import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import {
  JsonRpcRouter,
  type JsonRpcConnectionContext,
} from "@sunpilot/api";

function createContext(
  notifications: unknown[] = [],
): JsonRpcConnectionContext {
  return {
    source: "web",
    connectionId: "ws_test",
    runSubscriptions: new Set(),
    conversationSubscriptions: new Set(),
    notify: (notification) => notifications.push(notification),
  };
}

describe("JsonRpcRouter", () => {
  test("routes chat.send through AgentService and forwards Agent events with real DB sequence", async () => {
    const notifications: unknown[] = [];
    const calls: unknown[] = [];
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      getChatAgent: async () =>
        ({
          handleChatCommand: async (input: any, ctx: any, hooks: any) => {
            calls.push({ input, ctx });
            // liveEventBus events always carry a real DB sequence
            hooks?.onEvent?.({
              id: "evt_delta",
              type: "agent.response.delta",
              sequence: 42,
              runId: "run_1",
              conversationId: "conv_1",
              payload: {
                runId: "run_1",
                conversationId: "conv_1",
                messageId: "msg_1",
                delta: "hi",
              },
              createdAt: "2026-06-06T00:00:00.000Z",
            });
            hooks?.onEvent?.({
              id: "evt_started",
              type: "agent.response.started",
              sequence: 41,
              runId: "run_1",
              conversationId: "conv_1",
              payload: {
                runId: "run_1",
                messageId: "msg_1",
              },
              createdAt: "2026-06-06T00:00:00.000Z",
            });
            return {
              runId: "run_1",
              conversationId: "conv_1",
              messageId: "msg_1",
              status: "completed",
              artifacts: [],
              toolCalls: [],
            };
          },
        }) as any,
    });

    await expect(
      router.handle(
        {
          method: "chat.send",
          params: {
            conversationId: "conv_1",
            message: "hello",
            mode: "agent",
            clientRequestId: "req_1",
          },
        },
        createContext(notifications),
      ),
    ).resolves.toEqual({
      result: {
        accepted: true,
        conversationId: "conv_1",
        runId: "run_1",
        messageId: "msg_1",
      },
    });

    expect(calls).toEqual([
      {
        input: expect.objectContaining({
          conversationId: "conv_1",
          message: "hello",
          mode: "agent",
          clientRequestId: "req_1",
        }),
        ctx: { source: "web", connectionId: "ws_test" },
      },
    ]);

    // Normal agent.* notifications must carry a real DB sequence, never -1.
    // agent.error is the only transient notification allowed to have sequence: -1.
    expect(notifications).toHaveLength(2);
    for (const n of notifications) {
      const notif = n as { method: string; params: { sequence: number; eventId: string } };
      expect(notif.method).toMatch(/^agent\./);
      expect(notif.params.sequence).toBeGreaterThan(0);
    }
    expect(notifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "agent.response.delta",
        params: expect.objectContaining({
          eventId: "evt_delta",
          sequence: 42,
          payload: expect.objectContaining({ delta: "hi" }),
        }),
      },
      {
        jsonrpc: "2.0",
        method: "agent.response.started",
        params: expect.objectContaining({
          eventId: "evt_started",
          sequence: 41,
          payload: expect.objectContaining({ messageId: "msg_1" }),
        }),
      },
    ]);
  });

  test("agent.error notification may have sequence: -1 as it is transient", async () => {
    const notifications: unknown[] = [];
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      getChatAgent: async () =>
        ({
          handleChatCommand: async (_input: any, _ctx: any, hooks: any) => {
            hooks?.onError?.(new Error("something broke"));
            throw new Error("something broke");
          },
        }) as any,
    });

    await expect(
      router.handle(
        {
          method: "chat.send",
          params: { message: "hi" },
        },
        createContext(notifications),
      ),
    ).rejects.toThrow("something broke");

    // onError produces an agent.error notification via agentErrorNotification —
    // this is transient and sequence: -1 is expected.
    const errorNotifs = notifications.filter(
      (n) => (n as { method: string }).method === "agent.error",
    );
    expect(errorNotifs).toHaveLength(1);
    const errParams = (errorNotifs[0] as { params: { sequence: number } }).params;
    expect(errParams.sequence).toBe(-1);
  });

  test("subscribes to a conversation and replays missed events", async () => {
    const db = new InMemoryDatabaseContext();
    await db.events.append({
      id: "evt_1",
      runId: "run_1",
      conversationId: "conv_1",
      type: "agent.approval.required",
      payload: { approvalId: "approval_1" },
      createdAt: "2026-06-06T00:00:00.000Z",
    });
    const notifications: unknown[] = [];
    const ctx = createContext(notifications);
    const router = new JsonRpcRouter({
      database: db,
      getChatAgent: async () => ({}) as any,
    });

    await expect(
      router.handle(
        {
          method: "conversation.subscribe",
          params: { conversationId: "conv_1", lastSeenSequence: 0 },
        },
        ctx,
      ),
    ).resolves.toEqual({
      result: {
        conversationId: "conv_1",
        subscribed: true,
        replayed: 1,
        latestSequence: 1,
      },
    });

    expect(ctx.conversationSubscriptions.has("conv_1")).toBe(true);
    expect(notifications).toEqual([
      expect.objectContaining({
        method: "agent.approval.required",
        params: expect.objectContaining({ eventId: "evt_1", sequence: 1 }),
      }),
    ]);
  });

  test("surfaces Agent run.cancel errors without falling back to the legacy runtime", async () => {
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      getChatAgent: async () =>
        ({
          cancelRun: async () => {
            throw Object.assign(new Error("not found"), {
              code: "AGENT_RUN_NOT_FOUND",
            });
          },
        }) as any,
    });

    await expect(
      router.handle(
        { method: "run.cancel", params: { runId: "run_legacy" } },
        createContext(),
      ),
    ).rejects.toMatchObject({ code: "AGENT_RUN_NOT_FOUND" });
  });

  test("routes run.retry to AgentService first", async () => {
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      getChatAgent: async () =>
        ({
          retryRun: async (runId: string) => ({
            retried: true,
            originalRunId: runId,
            runId: "run_retry",
            conversationId: "conv_retry",
            messageId: "msg_retry",
            status: "completed",
          }),
        }) as any,
    });

    await expect(
      router.handle(
        { method: "run.retry", params: { runId: "run_old" } },
        createContext(),
      ),
    ).resolves.toEqual({
      result: {
        retried: true,
        originalRunId: "run_old",
        runId: "run_retry",
        conversationId: "conv_retry",
        messageId: "msg_retry",
        status: "completed",
      },
    });
  });

  test("surfaces Agent run.retry errors without falling back to the legacy runtime", async () => {
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      getChatAgent: async () =>
        ({
          retryRun: async () => {
            throw Object.assign(new Error("not found"), {
              code: "AGENT_RUN_NOT_FOUND",
            });
          },
        }) as any,
    });

    await expect(
      router.handle(
        { method: "run.retry", params: { runId: "run_legacy" } },
        createContext(),
      ),
    ).rejects.toMatchObject({ code: "AGENT_RUN_NOT_FOUND" });
  });

  test("returns a JSON-RPC method-not-found error for unknown commands", async () => {
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      getChatAgent: async () => ({}) as any,
    });

    await expect(
      router.handle({ method: "missing.method" }, createContext()),
    ).resolves.toEqual({
      error: { code: -32601, message: "Method not found" },
    });
  });
});
