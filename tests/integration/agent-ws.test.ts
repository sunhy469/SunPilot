import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createDaemon } from "@sunpilot/daemon";
import { InMemoryDatabaseContext } from "@sunpilot/storage";

describe("daemon Agent WebSocket integration", () => {
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  let previousTokenAuth: string | undefined;
  let previousHome: string | undefined;
  let home: string;

  beforeEach(() => {
    previousTokenAuth = process.env.SUNPILOT_DISABLE_TOKEN_AUTH;
    delete process.env.SUNPILOT_DISABLE_TOKEN_AUTH;
    previousHome = process.env.SUNPILOT_HOME;
    home = mkdtempSync(join(tmpdir(), "sunpilot-ws-integration-"));
    process.env.SUNPILOT_HOME = home;
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    if (previousTokenAuth === undefined) {
      delete process.env.SUNPILOT_DISABLE_TOKEN_AUTH;
    } else {
      process.env.SUNPILOT_DISABLE_TOKEN_AUTH = previousTokenAuth;
    }
    if (previousHome === undefined) delete process.env.SUNPILOT_HOME;
    else process.env.SUNPILOT_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("streams Agent events and returns chat.send acknowledgement", async () => {
    const db = new InMemoryDatabaseContext();
    daemon = await createDaemon({
      database: db,
      port: 0,
      chatAgent: {
        startChatCommand: async (input: any, _ctx: any, hooks: any) => {
          // Emit agent.* events through streamHooks so the JSON-RPC
          // router can forward them as WebSocket notifications.
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
          hooks?.onDelta?.({
            type: "agent.message.part.delta",
            conversationId: input.conversationId ?? "conv_integration",
            messageId: "msg_integration",
            partId: "part_text_1",
            delta: "hello integration",
          });
          return {
            accepted: true as const,
            runId: "run_integration",
            conversationId: input.conversationId ?? "conv_integration",
            messageId: "msg_integration",
          };
        },
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
          hooks?.onDelta?.({
            type: "agent.message.part.delta",
            conversationId: input.conversationId ?? "conv_integration",
            messageId: "msg_integration",
            partId: "part_text_1",
            delta: "hello integration",
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
        reject: async () => ({ rejected: true, runId: "run_integration", strategy: "interrupt" }),
      },
    });
    await daemon.start();

    const pidEntry = JSON.parse(readFileSync(daemon.paths.pidFile, "utf8"));
    expect(pidEntry).toMatchObject({
      pid: process.pid,
      startedAt: expect.any(String),
      processStartTicks: expect.stringMatching(/^\d+$/),
    });

    const address = daemon.app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Daemon did not expose a TCP address.");
    }

    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      daemon: "alive",
    });

    const unauthorized = new WebSocket(`ws://127.0.0.1:${address.port}/v1/ws`, {
      headers: { Origin: `http://localhost:${address.port}` },
    });
    const unauthorizedStatus = await new Promise<number>((resolve) => {
      unauthorized.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
    });
    expect(unauthorizedStatus).toBe(401);

    const token = readFileSync(daemon.paths.token, "utf8").trim();
    const ws = new WebSocket(
      `ws://127.0.0.1:${address.port}/v1/ws?token=${encodeURIComponent(token)}`,
    );
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
          method: "agent.message.part.delta",
          params: expect.objectContaining({
            payload: expect.objectContaining({ delta: "hello integration", partId: "part_text_1" }),
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
