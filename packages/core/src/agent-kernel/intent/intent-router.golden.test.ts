/**
 * Golden tests for IntentRouter — prevent regression on Chinese
 * false-positive tool matching (§P1 of architecture review).
 *
 * These tests validate that:
 *   1. Natural-language queries don't trigger wrong tool categories
 *   2. Form-match rules correctly identify CLI commands
 *   3. The removed regex rules no longer cause false positives
 *   4. Unknown intents gracefully fall through to no-tool
 *
 * Each test records expected intent type, tools, and approval flag.
 * Failures here indicate a routing regression.
 */

import { describe, expect, test } from "vitest";
import { IntentRouter } from "./intent-router.js";
import type { AgentContext, RoutedIntent } from "../loop-types.js";

// ── Shared test context ───────────────────────────────────────────

function makeContext(message: string): AgentContext {
  return {
    runId: "golden_run",
    conversationId: "golden_conv",
    system: { persona: "test", rules: [], safety: [] },
    currentMessage: {
      id: "msg_1",
      content: message,
      attachments: [],
    },
    messages: [],
    memories: [],
    artifacts: [],
    toolResults: [],
    availableSkills: [
      // A search skill that should NOT match travel/general queries
      {
        id: "jaderoad:product.source.search1688",
        name: "搜索 1688 货源",
        description: "Search 1688 by product image or text query.",
        category: "web",
      },
      // An image generation skill
      {
        id: "jaderoad:image.generate",
        name: "生成 Seedream 商品图",
        description: "Generate product showcase images via Seedream AI.",
        category: "web",
      },
      // A filesystem skill for shell commands
      {
        id: "sunpilot:filesystem.read",
        name: "Read file",
        description: "Read contents of a file from disk.",
        category: "filesystem",
      },
      {
        id: "sunpilot:shell.execute",
        name: "Execute shell command",
        description: "Run a shell command and return stdout/stderr.",
        category: "shell",
      },
    ],
    limits: {
      maxTokens: 8_000,
      reservedForOutput: 1_000,
      usedTokensEstimate: 10,
    },
    tokenEstimate: 10,
    startedAt: new Date().toISOString(),
    toolUsageWarning: { currentCount: 0, maxCount: 10 },
    config: {
      agentName: "test",
      model: "test-model",
    },
  };
}

// ── Helper ────────────────────────────────────────────────────────

async function route(msg: string): Promise<RoutedIntent> {
  const router = new IntentRouter({
    // No LLM, no embeddingService — pure form-match + default
  });
  return router.route(makeContext(msg), new AbortController().signal);
}

// ── Golden Tests ──────────────────────────────────────────────────

describe("IntentRouter golden tests", () => {
  // ── Negative cases: natural-language queries MUST NOT trigger tools ──

  describe("negative — natural language must not match wrong tool", () => {
    test('"搜索一下日照旅游攻略" → unknown (NOT use_skill)', async () => {
      const result = await route("搜索一下日照旅游攻略");
      expect(result.type).not.toBe("use_skill");
      expect(result.candidateSkills).toEqual([]);
      expect(result.requiresTool).toBe(false);
    });

    test('"帮我找一下附近好吃的地方" → unknown (NOT use_skill)', async () => {
      const result = await route("帮我找一下附近好吃的地方");
      expect(result.type).not.toBe("use_skill");
      expect(result.candidateSkills).toEqual([]);
    });

    test('"搜索一下今天有什么新闻" → unknown (NOT use_skill)', async () => {
      const result = await route("搜索一下今天有什么新闻");
      expect(result.type).not.toBe("use_skill");
      expect(result.candidateSkills).toEqual([]);
    });

    test('"find a good restaurant near me" → unknown (NOT use_skill)', async () => {
      const result = await route("find a good restaurant near me");
      expect(result.type).not.toBe("use_skill");
      expect(result.candidateSkills).toEqual([]);
    });

    test('"search for the latest iPhone review" → unknown', async () => {
      const result = await route("search for the latest iPhone review");
      // "search" was in the old use_skill regex — must not match now
      expect(result.type).not.toBe("use_skill");
    });
  });

  // ── Positive cases: form-match rules correctly identify commands ──

  describe("positive — form-match rules correctly match CLI syntax", () => {
    test('"pnpm test" → shell_operation with approval', async () => {
      const result = await route("pnpm test");
      expect(result.type).toBe("shell_operation");
      expect(result.confidence).toBeGreaterThanOrEqual(0.8);
      expect(result.requiresApproval).toBe(true);
      expect(result.riskLevel).toBe("high");
      expect(result.candidateSkills).toContain("shell.execute");
    });

    test('"npm run build" → shell_operation', async () => {
      const result = await route("npm run build");
      expect(result.type).toBe("shell_operation");
      expect(result.requiresTool).toBe(true);
    });

    test('"yarn install" → shell_operation', async () => {
      const result = await route("yarn install");
      expect(result.type).toBe("shell_operation");
    });

    test('"docker ps" → shell_operation', async () => {
      const result = await route("docker ps");
      expect(result.type).toBe("shell_operation");
    });

    test('"git status" → shell_operation', async () => {
      const result = await route("git status");
      expect(result.type).toBe("shell_operation");
    });
  });

  // ── Casual chat: short greetings still work ──

  describe("positive — short greetings match casual_chat", () => {
    test('"hi" → casual_chat (no tools)', async () => {
      const result = await route("hi");
      expect(result.type).toBe("casual_chat");
      expect(result.requiresTool).toBe(false);
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    test('"你好" → casual_chat', async () => {
      const result = await route("你好");
      expect(result.type).toBe("casual_chat");
    });

    test('"thanks" → casual_chat', async () => {
      const result = await route("thanks");
      expect(result.type).toBe("casual_chat");
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────

  describe("edge cases", () => {
    test("long message containing 'search' word does NOT trigger use_skill", async () => {
      // The word "search" was in the old use_skill regex pattern.
      // After removal, it should not trigger any tool intent.
      const result = await route(
        "I want to search for some documentation about PostgreSQL performance tuning",
      );
      expect(result.type).not.toBe("use_skill");
    });

    test("message with Chinese '搜' does NOT trigger use_skill", async () => {
      const result = await route("我想搜一下怎么配置nginx反向代理");
      expect(result.type).not.toBe("use_skill");
    });

    test("message with '找' does NOT trigger use_skill", async () => {
      const result = await route("帮我找一个合适的开源框架");
      expect(result.type).not.toBe("use_skill");
    });
  });
});
