import { describe, expect, test } from "vitest";
import { ZodError, z } from "zod";
import {
  rpcError,
  agentEventParams,
  websocketNotificationForEvent,
  agentErrorNotification,
} from "./ws-protocol.js";
import { JSON_RPC_ERROR_CODES } from "@sunpilot/protocol";

describe("rpcError", () => {
  test("maps SyntaxError to PARSE_ERROR", () => {
    const result = rpcError(new SyntaxError("Unexpected token"));
    expect(result.code).toBe(JSON_RPC_ERROR_CODES.PARSE_ERROR);
    expect(result.message).toBe("Parse error");
  });

  test("maps ZodError to INVALID_PARAMS with issues in data", () => {
    try {
      z.object({ name: z.string().min(1) }).parse({ name: "" });
      throw new Error("should have thrown");
    } catch (err) {
      const result = rpcError(err);
      expect(result.code).toBe(JSON_RPC_ERROR_CODES.INVALID_PARAMS);
      expect(result.message).toBe("Invalid params");
      expect(result.data).toEqual(expect.any(Array));
    }
  });

  test("maps agent error object to its JSON-RPC code", () => {
    const agentError = {
      code: "AGENT_PERMISSION_DENIED",
      message: "Not allowed",
      category: "permission",
      retryable: false,
    };
    const result = rpcError(agentError);
    expect(result.code).toBe(JSON_RPC_ERROR_CODES.PERMISSION_ERROR);
    expect(result.message).toBe("Not allowed");
    expect(result.data).toMatchObject({
      agentCode: "AGENT_PERMISSION_DENIED",
      category: "permission",
      retryable: false,
    });
  });

  test("maps agent error with details", () => {
    const agentError = {
      code: "AGENT_APPROVAL_REQUIRED",
      message: "Need approval",
      category: "approval",
      retryable: true,
      details: { toolId: "tool_1" },
    };
    const result = rpcError(agentError);
    expect(result.code).toBe(JSON_RPC_ERROR_CODES.PERMISSION_ERROR);
    expect(result.data).toMatchObject({
      details: { toolId: "tool_1" },
      retryable: true,
    });
  });

  test("maps unknown error to generic INTERNAL_ERROR (no message leak)", () => {
    const result = rpcError(new Error("DB connection failed: postgres://user:pass@host"));
    expect(result.code).toBe(JSON_RPC_ERROR_CODES.INTERNAL_ERROR);
    expect(result.message).toBe("An internal server error occurred.");
    expect(result.message).not.toContain("postgres");
  });

  test("maps null to INTERNAL_ERROR", () => {
    const result = rpcError(null);
    expect(result.code).toBe(JSON_RPC_ERROR_CODES.INTERNAL_ERROR);
  });

  test("maps string to INTERNAL_ERROR", () => {
    const result = rpcError("something broke");
    expect(result.code).toBe(JSON_RPC_ERROR_CODES.INTERNAL_ERROR);
  });
});

describe("agentEventParams", () => {
  test("maps event with object payload", () => {
    const params = agentEventParams({
      id: "evt_1",
      sequence: 5,
      runId: "run_1",
      conversationId: "conv_1",
      payload: { text: "hello" },
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(params).toEqual({
      eventId: "evt_1",
      sequence: 5,
      runId: "run_1",
      conversationId: "conv_1",
      createdAt: "2026-06-29T00:00:00.000Z",
      payload: { text: "hello" },
    });
  });

  test("wraps non-object payload in { value }", () => {
    const params = agentEventParams({
      id: "evt_2",
      payload: "plain string",
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(params.payload).toEqual({ value: "plain string" });
  });

  test("defaults sequence to -1 when missing", () => {
    const params = agentEventParams({
      id: "evt_3",
      payload: {},
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(params.sequence).toBe(-1);
  });

  test("omits runId/conversationId when undefined", () => {
    const params = agentEventParams({
      id: "evt_4",
      payload: {},
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(params.runId).toBeUndefined();
    expect(params.conversationId).toBeUndefined();
  });
});

describe("websocketNotificationForEvent", () => {
  test("wraps event as JSON-RPC notification", () => {
    const notification = websocketNotificationForEvent({
      id: "evt_1",
      type: "agent.message.completed",
      sequence: 1,
      runId: "run_1",
      conversationId: "conv_1",
      payload: { content: "done" },
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(notification).toEqual({
      jsonrpc: "2.0",
      method: "agent.message.completed",
      params: expect.objectContaining({
        eventId: "evt_1",
        runId: "run_1",
        payload: { content: "done" },
      }),
    });
  });
});

describe("agentErrorNotification", () => {
  test("produces agent.error notification with rpcError in payload", () => {
    const notification = agentErrorNotification(
      new Error("internal failure"),
      "conv_1",
    );
    expect(notification.jsonrpc).toBe("2.0");
    expect(notification.method).toBe("agent.error");
    expect(notification.params.conversationId).toBe("conv_1");
    expect(notification.params.payload).toMatchObject({
      conversationId: "conv_1",
      error: expect.objectContaining({
        code: JSON_RPC_ERROR_CODES.INTERNAL_ERROR,
      }),
    });
  });

  test("works without conversationId", () => {
    const notification = agentErrorNotification(new Error("oops"));
    expect(notification.method).toBe("agent.error");
    expect(notification.params.payload).toMatchObject({
      conversationId: undefined,
    });
  });
});
