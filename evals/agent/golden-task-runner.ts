/**
 * Golden Task Runner — executes Golden Tasks against the Agent Loop
 * and produces pass/fail results with detailed failure information.
 *
 * Usage:
 *   import { runGoldenTasks } from "./evals/agent/golden-task-runner.js";
 *   import { coreGoldenTasks } from "./evals/agent/core-golden-tasks.js";
 *
 *   const report = await runGoldenTasks(coreGoldenTasks, agentService);
 *   console.log(`${report.passed}/${report.total} passed`);
 */

import type {
  GoldenTask,
  GoldenTaskResult,
  GoldenTaskFailure,
  GoldenTaskReport,
  GoldenTaskSuite,
} from "./golden-task.types.js";

export interface GoldenTaskRunnerDeps {
  /**
   * Execute a user message through the agent and return the observable
   * results. This is the integration point between the eval framework
   * and the AgentService.
   */
  executeTask: (task: GoldenTask) => Promise<{
    assistantMessage: string;
    toolCalls: Array<{ skillId: string; status: string; summary: string }>;
    runStatus: string;
    contextSnapshot?: {
      messageCount: number;
      memoryCount: number;
      tokenEstimate: number;
    };
    modelCalls: { count: number; totalTokens: number; purpose: string[] };
    durationMs: number;
  }>;
}

/**
 * Run a single Golden Task and produce a result.
 */
export async function runGoldenTask(
  task: GoldenTask,
  deps: GoldenTaskRunnerDeps,
): Promise<GoldenTaskResult> {
  const failures: GoldenTaskFailure[] = [];

  const startTime = Date.now();
  let actual:
    | Awaited<ReturnType<GoldenTaskRunnerDeps["executeTask"]>>
    | undefined;

  try {
    actual = await deps.executeTask(task);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    failures.push({
      rule: "execution_error",
      expected: "Task to complete without throwing",
      actual: err.message,
    });
    return {
      taskId: task.id,
      passed: false,
      failures,
      actualToolCalls: [],
      actualToolSequence: [],
      modelCalls: { count: 0, totalTokens: 0, purpose: [] },
      durationMs: Date.now() - startTime,
    };
  }

  const actualToolIds = actual.toolCalls.map((tc) => tc.skillId);

  // ── Check expectations ───────────────────────────────────────────

  // mustCallTools
  if (task.expectations.mustCallTools) {
    for (const expectedTool of task.expectations.mustCallTools) {
      if (!actualToolIds.includes(expectedTool)) {
        failures.push({
          rule: "mustCallTools",
          expected: `Tool "${expectedTool}" must be called`,
          actual: `Called tools: [${actualToolIds.join(", ") || "none"}]`,
        });
      }
    }
  }

  // mustNotCallTools
  if (task.expectations.mustNotCallTools) {
    for (const forbiddenTool of task.expectations.mustNotCallTools) {
      if (actualToolIds.includes(forbiddenTool)) {
        failures.push({
          rule: "mustNotCallTools",
          expected: `Tool "${forbiddenTool}" must NOT be called`,
          actual: `Called "${forbiddenTool}"`,
        });
      }
    }
  }

  // mustContain
  if (task.expectations.mustContain) {
    const response = actual.assistantMessage;
    for (const required of task.expectations.mustContain) {
      if (!response.includes(required)) {
        failures.push({
          rule: "mustContain",
          expected: `Response must contain "${required}"`,
          actual: `Response snippet: "${response.slice(0, 200)}..."`,
        });
      }
    }
  }

  // mustNotContain
  if (task.expectations.mustNotContain) {
    const response = actual.assistantMessage;
    for (const forbidden of task.expectations.mustNotContain) {
      if (response.includes(forbidden)) {
        failures.push({
          rule: "mustNotContain",
          expected: `Response must NOT contain "${forbidden}"`,
          actual: `Found "${forbidden}" in response`,
        });
      }
    }
  }

  // mustNotFabricate
  if (task.expectations.mustNotFabricate) {
    const noToolCalls = actual.toolCalls.length === 0;
    const hasSearchLikeResponse =
      /找到|结果|商品|价格|货源|product|result|found/i.test(
        actual.assistantMessage,
      );
    if (noToolCalls && hasSearchLikeResponse) {
      failures.push({
        rule: "mustNotFabricate",
        expected: "Agent must not produce search-like results without tool execution",
        actual: `No tool calls but response contains result-like content: "${actual.assistantMessage.slice(0, 200)}..."`,
      });
    }
  }

  // mustAskClarification
  if (task.expectations.mustAskClarification) {
    const asksQuestion =
      /请问|请提供|需要.*参数|缺少|missing|provide/i.test(
        actual.assistantMessage,
      );
    if (!asksQuestion && actual.toolCalls.length === 0) {
      failures.push({
        rule: "mustAskClarification",
        expected: "Agent must ask for clarification when required params are missing",
        actual: `Response: "${actual.assistantMessage.slice(0, 200)}..."`,
      });
    }
  }

  // mustWaitForToolResults
  if (task.expectations.mustWaitForToolResults) {
    const calledRequiredTools = actual.toolCalls.length > 0;
    if (!calledRequiredTools) {
      failures.push({
        rule: "mustWaitForToolResults",
        expected: "Agent must execute tools and wait for results before responding",
        actual: `No tools called; response: "${actual.assistantMessage.slice(0, 200)}..."`,
      });
    }
  }

  // expectedRunStatus
  if (
    task.expectations.expectedRunStatus &&
    actual.runStatus !== task.expectations.expectedRunStatus
  ) {
    failures.push({
      rule: "expectedRunStatus",
      expected: `Run status should be "${task.expectations.expectedRunStatus}"`,
      actual: `Run status was "${actual.runStatus}"`,
    });
  }

  // maxToolIterations
  if (
    task.expectations.maxToolIterations !== undefined &&
    actual.toolCalls.length > task.expectations.maxToolIterations
  ) {
    failures.push({
      rule: "maxToolIterations",
      expected: `At most ${task.expectations.maxToolIterations} tool iterations`,
      actual: `${actual.toolCalls.length} tool iterations`,
    });
  }

  // mustCallInOrder
  if (task.expectations.mustCallInOrder) {
    const actualSeq = actual.toolCalls.map((tc) => tc.skillId);
    const expectedSeq = task.expectations.mustCallInOrder;
    let expectedIdx = 0;
    for (const actualSkill of actualSeq) {
      if (
        expectedIdx < expectedSeq.length &&
        actualSkill === expectedSeq[expectedIdx]
      ) {
        expectedIdx++;
      }
    }
    if (expectedIdx < expectedSeq.length) {
      failures.push({
        rule: "mustCallInOrder",
        expected: `Tools called in order: ${expectedSeq.join(" → ")}`,
        actual: `Actual sequence: ${actualSeq.join(" → ") || "none"}`,
      });
    }
  }

  return {
    taskId: task.id,
    passed: failures.length === 0,
    failures,
    actualToolCalls: actualToolIds,
    actualToolSequence: actual.toolCalls,
    contextSummary: actual.contextSnapshot,
    modelCalls: actual.modelCalls,
    durationMs: actual.durationMs,
  };
}

/**
 * Run a full suite of Golden Tasks and produce a report.
 */
export async function runGoldenTasks(
  suite: GoldenTaskSuite,
  deps: GoldenTaskRunnerDeps,
): Promise<GoldenTaskReport> {
  const results: GoldenTaskResult[] = [];

  for (const task of suite.tasks) {
    const result = await runGoldenTask(task, deps);
    results.push(result);
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const skipped = suite.tasks.length - results.length;

  const failedNames = results
    .filter((r) => !r.passed)
    .map((r) => `  ❌ ${r.taskId}: ${r.failures.map((f) => f.rule).join(", ")}`)
    .join("\n");

  return {
    suiteName: suite.name,
    timestamp: new Date().toISOString(),
    total: suite.tasks.length,
    passed,
    failed,
    skipped,
    results,
    summary:
      failed === 0
        ? `✅ All ${passed} Golden Tasks passed.`
        : `❌ ${failed}/${suite.tasks.length} Golden Tasks failed:\n${failedNames}`,
  };
}
