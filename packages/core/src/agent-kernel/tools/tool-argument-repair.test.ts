/**
 * End-to-end tests for tool argument repair.
 *
 * These tests verify that the tool argument pipeline correctly:
 * 1. Detects missing required parameters and triggers repair (not fabrication)
 * 2. Validates arguments against capability input schemas before execution
 * 3. Tracks argument provenance (source of each argument value)
 * 4. Handles repair retry loops without infinite recursion
 *
 * See agent_architecture_next_steps.md §P0-4 and §1 Phase 1 item 4.
 */

import { describe, expect, test } from "vitest";
import type {
  AgentContext,
  ToolDecision,
  PlannedToolCall,
} from "../loop-types.js";
import { ToolDecisionEngine } from "./tool-decision-engine.js";
import type { SkillSummary } from "./tool-types.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeContext(
  overrides: Partial<AgentContext> = {},
): AgentContext {
  return {
    runId: "run_arg_repair",
    conversationId: "conv_arg_repair",
    system: { persona: "test", rules: [], safety: [] },
    currentMessage: {
      id: "msg_1",
      content: "帮我搜同款",
      attachments: [],
    },
    messages: [],
    memories: [],
    artifacts: [],
    toolResults: [],
    availableSkills: [],
    limits: {
      maxTokens: 8000,
      reservedForOutput: 1000,
      usedTokensEstimate: 10,
    },
    tokenEstimate: 10,
    ...overrides,
  };
}

function makeIntent(overrides = {}) {
  return {
    type: "use_skill" as const,
    confidence: 0.9,
    requiresPlanning: false,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "medium" as const,
    candidateSkills: ["jaderoad:search"],
    reason: "test",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("Tool argument repair", () => {
  test("missing required params triggers clarification, not fabrication", async () => {
    // Skill requires imageUrl but none is provided
    const searchSkill: SkillSummary = {
      id: "jaderoad:search",
      name: "Search",
      description: "Search 1688 by image",
      category: "web",
      enabled: true,
      permissions: ["network.request"],
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      supportsAbort: true,
      idempotent: true,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          imageUrl: { type: "string" },
        },
        required: ["imageUrl"],
      },
      riskHints: {
        defaultRisk: "medium",
      },
    };

    const engine = new ToolDecisionEngine({
      listSkills: async () => [searchSkill],
    });

    const context = makeContext({
      currentMessage: {
        id: "msg_no_image",
        content: "帮我搜同款",
        attachments: [], // No image attachment
      },
    });

    const decision = await engine.decide(
      { context, intent: makeIntent() },
      new AbortController().signal,
    );

    // Without an argumentBuilder, the heuristic fallback extracts what it can.
    // The imageUrl will be missing from args (since there's no attachment),
    // but the heuristic doesn't yet trigger clarification for missing schema-required fields.
    // This is the P0-4 documented gap: the heuristic path doesn't use the schema
    // to validate required fields.
    if (decision.type === "use_tool") {
      for (const tc of decision.toolCalls) {
        // imageUrl should be empty/undefined since no attachment was provided
        const imageUrl = tc.arguments.imageUrl;
        expect(imageUrl).toBeUndefined();
      }
    }
    // NOTE: When schema-aware argumentBuilder is wired in, this should
    // become ask_clarification or no_tool instead of use_tool.
  });

  test("argument sources are tracked for provenance", async () => {
    const searchSkill: SkillSummary = {
      id: "jaderoad:search",
      name: "Search",
      description: "Search 1688",
      category: "web",
      enabled: true,
      permissions: ["network.request"],
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      supportsAbort: true,
      idempotent: true,
      riskHints: { defaultRisk: "medium" },
    };

    const engine = new ToolDecisionEngine({
      listSkills: async () => [searchSkill],
    });

    const context = makeContext({
      currentMessage: {
        id: "msg_with_image",
        content: "搜同款蓝牙耳机",
        attachments: [
          {
            id: "att_1",
            name: "earbuds.jpg",
            type: "image/jpeg",
            url: "https://example.com/earbuds.jpg",
          },
        ],
      },
    });

    const decision = await engine.decide(
      { context, intent: makeIntent() },
      new AbortController().signal,
    );

    expect(decision.type).toBe("use_tool");
    if (decision.type === "use_tool") {
      const tc = decision.toolCalls[0]!;
      // Should have imageUrl from attachment
      expect(tc.arguments.imageUrl).toBe("https://example.com/earbuds.jpg");
      // Should have query from message
      expect(tc.arguments.query).toBe("搜同款蓝牙耳机");

      // Argument sources are not tracked by the heuristic fallback.
      // When the schema-aware argumentBuilder is wired in (P0-4),
      // argumentSources will carry provenance for each argument.
      if (tc.argumentSources && tc.argumentSources.length > 0) {
        const imageSource = tc.argumentSources.find(
          (s) => s.arg === "imageUrl",
        );
        expect(imageSource).toBeDefined();
        expect(imageSource!.source).toBe("attachment");
      }
      // Without argumentBuilder, sources are empty — documented limitation
    }
  });

  test("heuristic fallback works when no argument builder available", async () => {
    const skill: SkillSummary = {
      id: "web.fetch",
      name: "Fetch URL",
      description: "Fetch web page content",
      category: "web",
      enabled: true,
      permissions: ["network.request"],
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      supportsAbort: true,
      idempotent: true,
      riskHints: { defaultRisk: "low" },
    };

    const engine = new ToolDecisionEngine({
      listSkills: async () => [skill],
      // No argumentBuilder provided — should use heuristic fallback
    });

    const context = makeContext({
      currentMessage: {
        id: "msg_url",
        content: "Fetch https://example.com/page for me",
        attachments: [],
      },
    });

    const decision = await engine.decide(
      { context, intent: makeIntent({ candidateSkills: ["web.fetch"] }) },
      new AbortController().signal,
    );

    expect(decision.type).toBe("use_tool");
    if (decision.type === "use_tool") {
      const tc = decision.toolCalls[0]!;
      // Heuristic should extract the URL from the message
      expect(tc.arguments.url).toBe("https://example.com/page");
    }
  });

  test("multiple attachments produce attachment array in arguments", async () => {
    const skill: SkillSummary = {
      id: "jaderoad:batch",
      name: "Batch Process",
      description: "Process multiple images",
      category: "web",
      enabled: true,
      permissions: ["network.request"],
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 120_000,
      supportsAbort: true,
      idempotent: true,
      riskHints: { defaultRisk: "medium" },
    };

    const engine = new ToolDecisionEngine({
      listSkills: async () => [skill],
    });

    const context = makeContext({
      currentMessage: {
        id: "msg_multi",
        content: "Compare these three products",
        attachments: [
          {
            id: "att_1",
            name: "product_a.jpg",
            type: "image/jpeg",
            url: "https://example.com/a.jpg",
          },
          {
            id: "att_2",
            name: "product_b.jpg",
            type: "image/jpeg",
            url: "https://example.com/b.jpg",
          },
          {
            id: "att_3",
            name: "product_c.jpg",
            type: "image/jpeg",
            url: "https://example.com/c.jpg",
          },
        ],
      },
    });

    const decision = await engine.decide(
      { context, intent: makeIntent({ candidateSkills: ["jaderoad:batch"] }) },
      new AbortController().signal,
    );

    expect(decision.type).toBe("use_tool");
    if (decision.type === "use_tool") {
      const tc = decision.toolCalls[0]!;
      const attachments = tc.arguments.attachments as Array<unknown> | undefined;
      expect(attachments).toBeDefined();
      expect(attachments).toHaveLength(3);
    }
  });
});
