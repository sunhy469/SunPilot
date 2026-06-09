import { describe, expect, test } from "vitest";
import { z } from "zod";
import { RuntimeError } from "@sunpilot/core";
import {
  agentErrorNotification,
  agentEventParams,
  rpcError,
  websocketNotificationForEvent,
} from "@sunpilot/api";

describe("rpcError", () => {
  test("maps Agent domain errors to JSON-RPC error data", () => {
    const error = Object.assign(new Error("Permission denied"), {
      code: "AGENT_PERMISSION_DENIED",
      category: "permission",
      retryable: false,
      details: { permission: "filesystem.delete" },
    });

    expect(rpcError(error)).toEqual({
      code: -32002,
      message: "Permission denied",
      data: {
        agentCode: "AGENT_PERMISSION_DENIED",
        category: "permission",
        retryable: false,
        details: { permission: "filesystem.delete" },
      },
    });
  });

  test("maps run state conflicts through the Agent JSON-RPC taxonomy", () => {
    const error = Object.assign(new Error("Run is already completed"), {
      code: "AGENT_RUN_STATE_CONFLICT",
      category: "run_state",
      retryable: false,
    });

    expect(rpcError(error)).toEqual({
      code: -32003,
      message: "Run is already completed",
      data: {
        agentCode: "AGENT_RUN_STATE_CONFLICT",
        category: "run_state",
        retryable: false,
      },
    });
  });

  test("uses standard JSON-RPC codes for parser and validation errors", () => {
    expect(rpcError(new SyntaxError("bad json"))).toEqual({
      code: -32700,
      message: "bad json",
    });

    expect(
      rpcError(z.object({ name: z.string() }).safeParse({}).error),
    ).toEqual(
      expect.objectContaining({
        code: -32602,
        message: "Invalid params",
        data: expect.any(Array),
      }),
    );
  });

  test("keeps legacy runtime errors in JSON-RPC data without reusing rate-limit codes", () => {
    expect(new RuntimeError("Missing run", 404, "not_found")).toBeInstanceOf(
      RuntimeError,
    );
    expect(rpcError(new RuntimeError("Missing run", 404, "not_found"))).toEqual(
      {
        code: -32001,
        message: "Missing run",
        data: {
          agentCode: "not_found",
          category: "internal",
          retryable: false,
        },
      },
    );
  });
});

describe("Agent WebSocket protocol helpers", () => {
  test("wraps Agent events in the canonical WebSocket envelope", () => {
    expect(
      websocketNotificationForEvent({
        id: "evt_1",
        sequence: 7,
        runId: "run_1",
        conversationId: "conv_1",
        type: "agent.response.delta",
        payload: { delta: "hello" },
        createdAt: "2026-06-06T00:00:00.000Z",
      }),
    ).toEqual({
      jsonrpc: "2.0",
      method: "agent.response.delta",
      params: {
        eventId: "evt_1",
        sequence: 7,
        runId: "run_1",
        conversationId: "conv_1",
        createdAt: "2026-06-06T00:00:00.000Z",
        payload: { delta: "hello" },
      },
    });
  });

  test("wraps agent.error notifications in the same envelope", () => {
    const notification = agentErrorNotification(
      Object.assign(new Error("Nope"), {
        code: "AGENT_RUN_STATE_CONFLICT",
        category: "run_state",
        retryable: false,
      }),
      "conv_1",
    );

    expect(notification).toEqual({
      jsonrpc: "2.0",
      method: "agent.error",
      params: expect.objectContaining({
        eventId: expect.stringMatching(/^evt_/),
        sequence: -1,
        conversationId: "conv_1",
        payload: {
          conversationId: "conv_1",
          error: {
            code: -32003,
            message: "Nope",
            data: {
              agentCode: "AGENT_RUN_STATE_CONFLICT",
              category: "run_state",
              retryable: false,
            },
          },
        },
      }),
    });
  });

  test("normalizes non-object payloads into envelope payload objects", () => {
    expect(
      agentEventParams({
        id: "evt_text",
        payload: "plain",
        createdAt: "2026-06-06T00:00:00.000Z",
      }),
    ).toEqual({
      eventId: "evt_text",
      sequence: -1,
      createdAt: "2026-06-06T00:00:00.000Z",
      payload: { value: "plain" },
    });
  });
});
