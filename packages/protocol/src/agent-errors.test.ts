import { describe, expect, test } from "vitest";
import {
  agentErrorToJsonRpcCode,
  AGENT_ERROR_CODES,
  JSON_RPC_ERROR_CODES,
  type AgentErrorCode,
} from "./agent-errors.js";

describe("agentErrorToJsonRpcCode", () => {
  test("maps AGENT_PERMISSION_DENIED to PERMISSION_ERROR", () => {
    expect(agentErrorToJsonRpcCode("AGENT_PERMISSION_DENIED")).toBe(
      JSON_RPC_ERROR_CODES.PERMISSION_ERROR,
    );
  });

  test("maps all approval errors to PERMISSION_ERROR", () => {
    const approvalCodes: AgentErrorCode[] = [
      "AGENT_APPROVAL_REQUIRED",
      "AGENT_APPROVAL_REJECTED",
      "AGENT_APPROVAL_EXPIRED",
      "AGENT_APPROVAL_ALREADY_DECIDED",
      "AGENT_APPROVAL_NOT_FOUND",
    ];
    for (const code of approvalCodes) {
      expect(agentErrorToJsonRpcCode(code)).toBe(
        JSON_RPC_ERROR_CODES.PERMISSION_ERROR,
      );
    }
  });

  test("maps run state conflicts to RUN_STATE_CONFLICT", () => {
    const stateCodes: AgentErrorCode[] = [
      "AGENT_RUN_STATE_CONFLICT",
      "AGENT_RUN_ALREADY_COMPLETED",
      "AGENT_RUN_ALREADY_CANCELLED",
      "AGENT_RUN_CANCELLED",
      "AGENT_RUN_INTERRUPTED",
    ];
    for (const code of stateCodes) {
      expect(agentErrorToJsonRpcCode(code)).toBe(
        JSON_RPC_ERROR_CODES.RUN_STATE_CONFLICT,
      );
    }
  });

  test("maps rate/concurrency limits to RATE_LIMIT", () => {
    expect(agentErrorToJsonRpcCode("AGENT_RATE_LIMITED")).toBe(
      JSON_RPC_ERROR_CODES.RATE_LIMIT,
    );
    expect(agentErrorToJsonRpcCode("AGENT_CONCURRENCY_LIMIT")).toBe(
      JSON_RPC_ERROR_CODES.RATE_LIMIT,
    );
  });

  test("maps model/tool upstream failures to UPSTREAM_FAILURE", () => {
    expect(agentErrorToJsonRpcCode("AGENT_MODEL_CALL_FAILED")).toBe(
      JSON_RPC_ERROR_CODES.UPSTREAM_FAILURE,
    );
    expect(agentErrorToJsonRpcCode("AGENT_TOOL_EXECUTION_FAILED")).toBe(
      JSON_RPC_ERROR_CODES.UPSTREAM_FAILURE,
    );
    expect(agentErrorToJsonRpcCode("AGENT_TOOL_TIMEOUT")).toBe(
      JSON_RPC_ERROR_CODES.UPSTREAM_FAILURE,
    );
  });

  test("maps unmapped codes to AGENT_DOMAIN_ERROR fallback", () => {
    const fallbackCodes: AgentErrorCode[] = [
      "AGENT_RUN_NOT_FOUND",
      "AGENT_TOOL_NOT_FOUND",
      "AGENT_TOOL_DISABLED",
      "AGENT_TOOL_ARGUMENT_INVALID",
      "AGENT_CONTEXT_BUDGET_EXCEEDED",
      "AGENT_MAX_STEPS_REACHED",
      "AGENT_MAX_TOOL_ROUNDS_REACHED",
      "AGENT_IDEMPOTENCY_CONFLICT",
      "AGENT_INTERNAL_ERROR",
      "AGENT_NOT_IMPLEMENTED",
    ];
    for (const code of fallbackCodes) {
      expect(agentErrorToJsonRpcCode(code)).toBe(
        JSON_RPC_ERROR_CODES.AGENT_DOMAIN_ERROR,
      );
    }
  });

  test("every AGENT_ERROR_CODE maps to a known JSON-RPC code", () => {
    const knownCodes = new Set<number>(Object.values(JSON_RPC_ERROR_CODES));
    for (const code of AGENT_ERROR_CODES) {
      const mapped = agentErrorToJsonRpcCode(code);
      expect(knownCodes.has(mapped)).toBe(true);
    }
  });
});
