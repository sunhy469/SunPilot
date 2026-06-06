import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import {
  JsonRpcRouter,
  type JsonRpcConnectionContext,
} from "./json-rpc-router.js";

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
  test("routes chat.send through AgentService and forwards Agent events", async () => {
    const notifications: unknown[] = [];
    const calls: unknown[] = [];
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      runtime: {} as any,
      runtimeStore: {} as any,
      getChatAgent: async () =>
        ({
          handleChatCommand: async (input: any, ctx: any, hooks: any) => {
            calls.push({ input, ctx });
            hooks?.onEvent?.({
              id: "evt_delta",
              type: "agent.response.delta",
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
    expect(notifications).toEqual([
      {
        jsonrpc: "2.0",
        method: "agent.response.delta",
        params: expect.objectContaining({
          eventId: "evt_delta",
          payload: expect.objectContaining({ delta: "hi" }),
        }),
      },
    ]);
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
      runtime: {} as any,
      runtimeStore: {} as any,
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

  test("falls back to workflow runtime when run.cancel is not an Agent run", async () => {
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      runtime: {
        cancel: async (runId: string) => ({ id: runId, status: "cancelled" }),
      } as any,
      runtimeStore: {} as any,
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
    ).resolves.toEqual({
      result: {
        cancelled: true,
        runId: "run_legacy",
        run: { id: "run_legacy", status: "cancelled" },
      },
    });
  });

  test("routes run.retry to AgentService first", async () => {
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      runtime: {
        retry: async () => {
          throw new Error("legacy runtime should not be called");
        },
      } as any,
      runtimeStore: {} as any,
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

  test("falls back to workflow runtime when run.retry is not an Agent run", async () => {
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      runtime: {
        retry: async (runId: string) => ({ id: `${runId}_retry` }),
      } as any,
      runtimeStore: {} as any,
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
    ).resolves.toEqual({
      result: { id: "run_legacy_retry" },
    });
  });

  test("returns a JSON-RPC method-not-found error for unknown commands", async () => {
    const router = new JsonRpcRouter({
      database: new InMemoryDatabaseContext(),
      runtime: {} as any,
      runtimeStore: {} as any,
      getChatAgent: async () => ({}) as any,
    });

    await expect(
      router.handle({ method: "missing.method" }, createContext()),
    ).resolves.toEqual({
      error: { code: -32601, message: "Method not found" },
    });
  });
});
