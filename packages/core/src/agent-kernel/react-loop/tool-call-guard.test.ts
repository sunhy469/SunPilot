import { describe, expect, test, vi } from "vitest";
import type { AgentContext } from "../loop-types.js";
import type { SkillSummary } from "../tools/tool-types.js";
import { ObservationBuilder } from "./observation-builder.js";
import { ToolCallGuard } from "./tool-call-guard.js";

const skill: SkillSummary = {
  id: "test:search",
  name: "Search",
  description: "Search",
  category: "web",
  enabled: true,
  permissions: ["network.request"],
  defaultTimeoutMs: 1_000,
  maxTimeoutMs: 2_000,
  supportsAbort: true,
  idempotent: true,
  inputSchema: {
    type: "object",
    required: ["query"],
    properties: { query: { type: "string" } },
  },
  riskHints: { defaultRisk: "low" },
};

describe("ToolCallGuard", () => {
  test.each([
    ["unknown tool", call("unknown", "missing", '{}')],
    ["malformed JSON", call("bad_json", "test_search", "{")],
    ["schema failure", call("bad_schema", "test_search", '{}')],
    [
      "unsafe object key",
      call("unsafe_key", "test_search", '{"query":"x","__proto__":{}}'),
    ],
  ])("returns an Observation for %s", async (_name, toolCall) => {
    const { guard, permission } = createGuard();
    const result = await check(guard, [toolCall]);

    expect(result.executable).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(permission).not.toHaveBeenCalled();
  });

  test("blocks an exact duplicate call", async () => {
    const { guard } = createGuard();
    const seen = new Map([[`test:search:{"query":"shirt"}`, 1]]);
    const result = await check(
      guard,
      [call("duplicate", "test_search", '{"query":"shirt"}')],
      seen,
    );

    expect(result.observations[0]?.kind).toBe("duplicate_tool_call");
    expect(result.executable).toEqual([]);
  });

  test("turns a permission denial into an Observation", async () => {
    const { guard } = createGuard({ allowed: false });
    const result = await check(
      guard,
      [call("denied", "test_search", '{"query":"shirt"}')],
    );

    expect(result.observations[0]?.kind).toBe("permission_denied");
    expect(result.executable).toEqual([]);
  });

  test("freezes the entire valid batch when one call requires approval", async () => {
    const second = { ...skill, id: "test:write", name: "Write" };
    const permission = vi.fn(async (input: { skillId: string }) => ({
      allowed: true,
      requiresApproval: input.skillId === second.id,
      riskLevel: input.skillId === second.id ? "high" as const : "low" as const,
      reasons: [],
    }));
    const guard = new ToolCallGuard({ evaluate: permission } as never, new ObservationBuilder(1_000));
    const result = await guard.check({
      runId: "run_1",
      context,
      calls: [
        call("read", "test_search", '{"query":"a"}'),
        call("write", "test_write", '{"query":"b"}'),
      ],
      toolNameMap: new Map([["test_search", skill.id], ["test_write", second.id]]),
      availableSkills: [skill, second],
      permissionMode: "auto",
      seenSignatures: new Map(),
      maxRepeatedToolCalls: 1,
    });

    expect(result.executable).toEqual([]);
    expect(result.approvalRequired.map((value) => value.id)).toEqual(["read", "write"]);
  });

  test("does not count a valid sibling that an invalid atomic batch prevented", async () => {
    const { guard } = createGuard();
    const seen = new Map<string, number>();
    const first = await check(
      guard,
      [
        call("valid_sibling", "test_search", '{"query":"shirt"}'),
        call("invalid_sibling", "test_search", '{}'),
      ],
      seen,
    );
    expect(first.executable).toEqual([]);
    expect(seen.get('test:search:{"query":"shirt"}')).toBeUndefined();

    const retry = await check(
      guard,
      [call("valid_retry", "test_search", '{"query":"shirt"}')],
      seen,
    );
    expect(retry.executable).toHaveLength(1);
  });

  test("honors a configured repeated-call threshold", async () => {
    const { guard } = createGuard();
    const seen = new Map([[`test:search:{"query":"shirt"}`, 1]]);
    const result = await guard.check({
      runId: "run_1",
      context,
      calls: [call("allowed_repeat", "test_search", '{"query":"shirt"}')],
      toolNameMap: new Map([["test_search", skill.id]]),
      availableSkills: [skill],
      permissionMode: "auto",
      seenSignatures: seen,
      maxRepeatedToolCalls: 2,
    });

    expect(result.executable).toHaveLength(1);
    expect(result.observations).toEqual([]);
  });

  test("rejects duplicate tool_call ids as an atomic protocol error", async () => {
    const { guard } = createGuard();
    const result = await check(guard, [
      call("same_id", "test_search", '{"query":"one"}'),
      call("same_id", "test_search", '{"query":"two"}'),
    ]);

    expect(result.executable).toEqual([]);
    expect(result.observations.some((observation) =>
      observation.displaySummary.includes("Duplicate tool_call_id"),
    )).toBe(true);
  });
});

function createGuard(overrides?: { allowed?: boolean }) {
  const permission = vi.fn(async () => ({
    allowed: overrides?.allowed ?? true,
    requiresApproval: false,
    riskLevel: "low" as const,
    reasons: overrides?.allowed === false ? ["denied"] : [],
  }));
  return {
    guard: new ToolCallGuard({ evaluate: permission } as never, new ObservationBuilder(1_000)),
    permission,
  };
}

function check(
  guard: ToolCallGuard,
  calls: ReturnType<typeof call>[],
  seenSignatures = new Map<string, number>(),
) {
  return guard.check({
    runId: "run_1",
    context,
    calls,
    toolNameMap: new Map([["test_search", skill.id]]),
    availableSkills: [skill],
    permissionMode: "auto",
    seenSignatures,
    maxRepeatedToolCalls: 1,
  });
}

function call(id: string, name: string, args: string) {
  return { id, type: "function" as const, function: { name, arguments: args } };
}

const context: AgentContext = {
  runId: "run_1",
  conversationId: "conv_1",
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: { id: "msg_1", content: "search", attachments: [] },
  messages: [], memories: [], artifacts: [], toolResults: [], availableSkills: [],
  limits: { maxTokens: 1_000, reservedForOutput: 100, usedTokensEstimate: 1 },
  tokenEstimate: 1,
};
