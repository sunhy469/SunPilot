import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createDaemon } from "@sunpilot/daemon";
import { InMemoryDatabaseContext } from "@sunpilot/storage";

describe("daemon Agent WebSocket integration", () => {
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
  });

  test("streams Agent events and returns chat.send acknowledgement", async () => {
    const db = new InMemoryDatabaseContext();
    daemon = await createDaemon({
      database: db,
      port: 0,
      chatAgent: {
        handleChatCommand: async (input: any, _ctx: any, hooks: any) => {
          hooks?.onEvent?.({
            id: "evt_run",
            type: "agent.run.created",
            runId: "run_integration",
            conversationId: input.conversationId ?? "conv_integration",
            payload: {
              runId: "run_integration",
              conversationId: input.conversationId ?? "conv_integration",
              mode: input.mode ?? "agent",
              goal: input.message,
            },
            createdAt: "2026-06-06T00:00:00.000Z",
          });
          hooks?.onEvent?.({
            id: "evt_delta",
            type: "agent.response.delta",
            runId: "run_integration",
            conversationId: input.conversationId ?? "conv_integration",
            payload: {
              runId: "run_integration",
              conversationId: input.conversationId ?? "conv_integration",
              messageId: "msg_integration",
              delta: "hello integration",
            },
            createdAt: "2026-06-06T00:00:01.000Z",
          });
          return {
            runId: "run_integration",
            conversationId: input.conversationId ?? "conv_integration",
            messageId: "msg_integration",
            status: "completed",
            artifacts: [],
            toolCalls: [],
          };
        },
        stopChat: () => ({ stopped: false, runId: "run_integration" }),
        cancelRun: async (runId: string) => ({
          cancelled: true,
          runId,
          stopped: false,
        }),
        resumeRun: async (runId: string) => ({
          resumed: true,
          originalRunId: runId,
          runId: "run_resumed",
          conversationId: "conv_integration",
          messageId: "msg_resumed",
          status: "completed",
        }),
        retryRun: async (runId: string) => ({
          retried: true,
          originalRunId: runId,
          runId: "run_retry",
          conversationId: "conv_integration",
          messageId: "msg_retry",
          status: "completed",
        }),
        approve: async () => ({ approved: true }),
        reject: async () => ({ rejected: true }),
      },
    });
    await daemon.start();

    const address = daemon.app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Daemon did not expose a TCP address.");
    }

    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      daemon: "alive",
    });

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`);
    const messages: any[] = [];
    ws.on("message", (data) => messages.push(JSON.parse(String(data))));
    await once(ws, "open");
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc_chat",
        method: "chat.send",
        params: {
          conversationId: "conv_integration",
          message: "hello",
          mode: "agent",
        },
      }),
    );

    await waitFor(() =>
      messages.some(
        (message) => message.id === "rpc_chat" && message.result?.accepted,
      ),
    );
    ws.close();

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "agent.run.created",
          params: expect.objectContaining({
            eventId: "evt_run",
            payload: expect.objectContaining({ goal: "hello" }),
          }),
        }),
        expect.objectContaining({
          method: "agent.response.delta",
          params: expect.objectContaining({
            eventId: "evt_delta",
            payload: expect.objectContaining({ delta: "hello integration" }),
          }),
        }),
        expect.objectContaining({
          id: "rpc_chat",
          result: expect.objectContaining({
            accepted: true,
            runId: "run_integration",
            messageId: "msg_integration",
          }),
        }),
      ]),
    );
  });
});

function once(target: WebSocket, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    target.once(event, () => resolve());
    target.once("error", reject);
  });
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for WebSocket messages.");
}
