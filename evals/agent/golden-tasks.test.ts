/**
 * Golden Task evaluation tests.
 *
 * These tests run the core Golden Tasks against the Agent Loop.
 * Each test encodes a critical behavior expectation — if any fail,
 * a regression has been introduced in the Agent Core.
 *
 * Two modes:
 * - Mock harness (default): Fast, deterministic — validates eval framework.
 * - Real agent (GOLDEN_TASKS_REAL_AGENT=true): Runs against real AgentService
 *   with InMemoryDatabaseContext and FakeLlmProvider. Validates agent behavior.
 *
 * Run with:
 *   pnpm eval:agent           (mock harness only)
 *   pnpm eval:agent:real      (real agent harness)
 */

import { describe, expect, test, beforeAll } from "vitest";
import { coreGoldenTasks } from "./core-golden-tasks.js";
import { runGoldenTask, runGoldenTasks } from "./golden-task-runner.js";
import type {
  GoldenTask,
  GoldenTaskResult,
} from "./golden-task.types.js";
import { FakeLlmProvider } from "./fake-llm-provider.js";
import { runGoldenTaskWithRealAgent } from "./agent-service-adapter.js";

// ── Feature flags ───────────────────────────────────────────────────────

const GOLDEN_TASKS_ENABLED =
  process.env.GOLDEN_TASKS_ENABLED !== "false";
const GOLDEN_TASKS_REAL_AGENT =
  process.env.GOLDEN_TASKS_REAL_AGENT === "true";

// ── Mock executor (validates eval harness, not agent behavior) ──────────

/**
 * Creates an executeTask adapter that validates against golden task
 * expectations without running a full Agent Loop. Used for fast
 * deterministic validation of the eval framework itself.
 */
function createMockExecutor() {
  return {
    async executeTask(task: GoldenTask) {
      const mustCall = task.expectations.mustCallTools ?? [];
      const mustNotCall = task.expectations.mustNotCallTools ?? [];

      const toolCalls = mustCall.map((skillId) => ({
        skillId,
        status: "completed" as const,
        summary: `Mock execution of ${skillId}`,
      }));

      // Remove tools that mustNotCall
      const filteredToolCalls = toolCalls.filter(
        (tc) => !mustNotCall.includes(tc.skillId),
      );

      const shouldAskClarify = task.expectations.mustAskClarification;
      const mustContain = task.expectations.mustContain ?? [];

      let assistantMessage: string;
      if (shouldAskClarify) {
        assistantMessage = `请问您能提供更多信息吗？需要以下参数：${mustContain.join(", ")}`;
      } else if (filteredToolCalls.length > 0) {
        assistantMessage = `已使用 ${filteredToolCalls.map((tc) => tc.skillId).join(", ")} 完成任务。${mustContain.join(" ")}`;
      } else {
        assistantMessage = `根据分析，${mustContain.join(" ")}`;
      }

      return {
        assistantMessage,
        toolCalls: filteredToolCalls,
        runStatus: task.expectations.expectedRunStatus ?? "completed",
        contextSnapshot: {
          messageCount: (task.conversationHistory?.length ?? 0) + 1,
          memoryCount: 0,
          tokenEstimate: 100,
        },
        modelCalls: {
          count: 1,
          totalTokens: 500,
          purpose: ["response"],
        },
        durationMs: 10,
      };
    },
  };
}

// ── Real agent adapter ──────────────────────────────────────────────────

/**
 * Creates a FakeLlmProvider with responses scripted for the specific
 * golden task being evaluated.
 */
function createTaskFakeLlm(task: GoldenTask): FakeLlmProvider {
  const fake = new FakeLlmProvider(`fake-${task.id}`);

  // Register purpose-specific responses based on task expectations
  const hasSearchTool = task.availableSkills.some((s) =>
    s.id.includes("search") || s.id.includes("jaderoad"),
  );

  if (hasSearchTool) {
    fake.register("intent_classification", {
      content: JSON.stringify({
        intent: "use_skill",
        confidence: 0.9,
        candidateSkills: task.availableSkills.map((s) => s.id),
      }),
    });

    fake.register("tool_argument_generation", {
      content: JSON.stringify({
        query: task.userMessage,
        imageUrl: task.attachments?.[0]?.url ?? undefined,
      }),
    });
  } else if (task.id === "missing-params-must-clarify") {
    fake.register("intent_classification", {
      content: JSON.stringify({
        intent: "clarify" as string,
        confidence: 0.8,
      }),
    });
  } else if (task.id === "prompt-injection-must-not-override") {
    fake.register("intent_classification", {
      content: JSON.stringify({
        intent: "use_skill",
        confidence: 0.9,
        candidateSkills: ["web.fetch"],
      }),
    });
  } else {
    fake.register("intent_classification", {
      content: JSON.stringify({
        intent: "use_skill",
        confidence: 0.9,
        candidateSkills: task.availableSkills.map((s) => s.id),
      }),
    });
  }

  // Default responses for other purposes
  fake.register("reflection", {
    content: JSON.stringify({
      goalAchieved: true,
      nextAction: "respond",
      confidence: 0.9,
      summary: "Task completed successfully.",
    }),
  });

  fake.register("response_composition", {
    content: task.expectations.mustContain
      ? task.expectations.mustContain.join(" ")
      : "任务已完成。",
  });

  fake.register("planning", {
    content: "Create a plan to execute the requested tool and respond.",
  });

  return fake;
}

// ── Tests ───────────────────────────────────────────────────────────────

const runOrSkip = GOLDEN_TASKS_ENABLED ? describe : describe.skip;

// ─── Mock harness tests (always run) ────────────────────────────────────

runOrSkip("Golden Tasks (Mock Harness)", () => {
  const executor = createMockExecutor();

  test("all core golden tasks are defined", () => {
    expect(coreGoldenTasks.tasks.length).toBeGreaterThanOrEqual(7);
    for (const task of coreGoldenTasks.tasks) {
      expect(task.id).toBeTruthy();
      expect(task.description).toBeTruthy();
      expect(task.expectations).toBeDefined();
    }
  });

  test("IMAGE_SEARCH_MUST_WAIT_FOR_TOOL passes with tool results", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "image-search-must-wait-for-tool",
    )!;
    const result = await runGoldenTask(task, executor);
    expect(result.passed).toBe(true);
    expect(result.actualToolCalls).toContain(
      "jaderoad:product.source.search1688",
    );
  });

  test("MISSING_PARAMS_MUST_CLARIFY passes when agent asks for clarification", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "missing-params-must-clarify",
    )!;
    const result = await runGoldenTask(task, executor);
    expect(result.passed).toBe(true);
    expect(result.actualToolCalls).not.toContain(
      "jaderoad:product.source.search1688",
    );
  });

  test("USER_REJECTS_TOOL_MUST_COMPLETE_REST passes when rejection is handled", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "user-rejects-tool-must-complete-rest",
    )!;
    const result = await runGoldenTask(task, executor);
    expect(result.passed).toBe(true);
    expect(result.actualToolCalls).not.toContain("filesystem.delete");
  });

  test("PROMPT_INJECTION_MUST_NOT_OVERRIDE passes when safety rules are enforced", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "prompt-injection-must-not-override",
    )!;
    const result = await runGoldenTask(task, executor);
    expect(result.passed).toBe(true);
  });

  test("LONG_CONVERSATION_MUST_RETAIN_KEY_CONSTRAINTS passes when constraints survive compression", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "long-conversation-must-retain-key-constraints",
    )!;
    const result = await runGoldenTask(task, executor);
    expect(result.passed).toBe(true);
    expect(result.actualToolCalls).toContain(
      "jaderoad:product.source.search1688",
    );
  });

  test("MEMORY_RECALL_MUST_RETURN_PREFERENCES passes when preferences are recalled", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "memory-recall-must-return-preferences",
    )!;
    const result = await runGoldenTask(task, executor);
    expect(result.passed).toBe(true);
  });

  test("TOOL_FAILURE_MUST_NOT_SILENTLY_STOP passes when retry is attempted", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "tool-failure-must-not-silently-stop",
    )!;
    const result = await runGoldenTask(task, executor);
    expect(result.passed).toBe(true);
  });

  test("full suite report is generated correctly", async () => {
    const report = await runGoldenTasks(coreGoldenTasks, executor);
    expect(report.total).toBe(coreGoldenTasks.tasks.length);
    expect(report.passed + report.failed + report.skipped).toBe(
      report.total,
    );
    expect(report.summary).toBeTruthy();
    expect(report.results).toHaveLength(report.total);
  });
});

// ─── Real Agent tests (opt-in via GOLDEN_TASKS_REAL_AGENT=true) ─────────

const runRealOrSkip = GOLDEN_TASKS_REAL_AGENT ? describe : describe.skip;

runRealOrSkip("Golden Tasks (Real AgentService)", () => {
  // Increase timeout — real agent loops take longer than mock
  const TEST_TIMEOUT = 30_000;

  test("IMAGE_SEARCH_MUST_WAIT_FOR_TOOL — real agent calls tool and waits", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "image-search-must-wait-for-tool",
    )!;
    const fakeLlm = createTaskFakeLlm(task);
    const result = await runGoldenTaskWithRealAgent(task, fakeLlm);
    expect(result.passed).toBe(true);
  }, TEST_TIMEOUT);

  test("MISSING_PARAMS_MUST_CLARIFY — real agent asks for clarification", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "missing-params-must-clarify",
    )!;
    const fakeLlm = createTaskFakeLlm(task);
    const result = await runGoldenTaskWithRealAgent(task, fakeLlm);
    expect(result.passed).toBe(true);
  }, TEST_TIMEOUT);

  test("USER_REJECTS_TOOL_MUST_COMPLETE_REST — real agent handles rejection", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "user-rejects-tool-must-complete-rest",
    )!;
    const fakeLlm = createTaskFakeLlm(task);
    const result = await runGoldenTaskWithRealAgent(task, fakeLlm);
    expect(result.passed).toBe(true);
  }, TEST_TIMEOUT);

  test("PROMPT_INJECTION_MUST_NOT_OVERRIDE — real agent blocks injection", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "prompt-injection-must-not-override",
    )!;
    const fakeLlm = createTaskFakeLlm(task);
    const result = await runGoldenTaskWithRealAgent(task, fakeLlm);
    expect(result.passed).toBe(true);
  }, TEST_TIMEOUT);

  test("LONG_CONVERSATION_MUST_RETAIN_KEY_CONSTRAINTS — real agent retains constraints", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "long-conversation-must-retain-key-constraints",
    )!;
    const fakeLlm = createTaskFakeLlm(task);
    const result = await runGoldenTaskWithRealAgent(task, fakeLlm);
    expect(result.passed).toBe(true);
  }, TEST_TIMEOUT);

  test("MEMORY_RECALL_MUST_RETURN_PREFERENCES — real agent recalls preferences", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "memory-recall-must-return-preferences",
    )!;
    const fakeLlm = createTaskFakeLlm(task);
    const result = await runGoldenTaskWithRealAgent(task, fakeLlm);
    expect(result.passed).toBe(true);
  }, TEST_TIMEOUT);

  test("TOOL_FAILURE_MUST_NOT_SILENTLY_STOP — real agent handles tool failure", async () => {
    const task = coreGoldenTasks.tasks.find(
      (t) => t.id === "tool-failure-must-not-silently-stop",
    )!;
    const fakeLlm = createTaskFakeLlm(task);
    const result = await runGoldenTaskWithRealAgent(task, fakeLlm);
    expect(result.passed).toBe(true);
  }, TEST_TIMEOUT);

  test("full suite report is generated correctly with real agent", async () => {
    const results: GoldenTaskResult[] = [];
    for (const task of coreGoldenTasks.tasks) {
      const fakeLlm = createTaskFakeLlm(task);
      const result = await runGoldenTaskWithRealAgent(task, fakeLlm);
      results.push(result);
    }

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    // Write report to disk
    const report = {
      suiteName: coreGoldenTasks.name,
      timestamp: new Date().toISOString(),
      total: coreGoldenTasks.tasks.length,
      passed,
      failed,
      skipped: 0,
      results,
      summary:
        failed === 0
          ? `✅ All ${passed} Golden Tasks passed with real AgentService.`
          : `❌ ${failed}/${coreGoldenTasks.tasks.length} Golden Tasks failed:\n${results
              .filter((r) => !r.passed)
              .map((r) => `  ❌ ${r.taskId}: ${r.failures.map((f) => f.rule).join(", ")}`)
              .join("\n")}`,
    };

    // Best-effort write to evals/reports/
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const reportsDir = path.resolve(
        import.meta.dirname ?? "evals/agent",
        "../reports",
      );
      const filename = `agent-golden-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      await fs.mkdir(reportsDir, { recursive: true });
      await fs.writeFile(
        path.join(reportsDir, filename),
        JSON.stringify(report, null, 2),
        "utf-8",
      );
      console.log(`Report written to evals/reports/${filename}`);
    } catch {
      // Report writing is best-effort; don't fail the test
      console.warn("Could not write golden task report to disk.");
    }

    console.log(`\n${report.summary}`);
    expect(failed).toBe(0);
  }, 120_000); // Longer timeout for full suite
});
