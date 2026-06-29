import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

describe("ReAct architecture constraints", () => {
  test("AgentLoopEngine has no legacy semantic-stage dependencies", () => {
    const source = readFileSync(
      new URL("../agent-loop-engine.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "PreliminaryInference",
      "IntentRouter",
      "ToolSelector",
      "ToolDecisionEngine",
      "ResponseComposer",
      "ReflectionEngine",
      "RuleBasedPlanner",
      "skipFirstLlmTurn",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(source).toContain("reactLoopRunner.run");
  });

  test("the runner executes only Guard-approved calls and has no business skill ids", () => {
    const source = readFileSync(new URL("./react-loop-runner.ts", import.meta.url), "utf8");
    expect(source).toContain("calls: guarded.executable");
    expect(source).not.toMatch(/["'](?:filesystem|shell|memory|artifact)\.[a-z]/);
    expect(source).not.toContain("outputIsFinal");
  });

  test("approval suspension persists the checkpoint before returning", () => {
    const source = readFileSync(new URL("./react-loop-runner.ts", import.meta.url), "utf8");
    const approvalBranch = source.slice(
      source.indexOf("if (guarded.approvalRequired.length > 0)"),
      source.indexOf("let roundObservations"),
    );
    expect(approvalBranch).toContain("await this.persist(checkpoint)");
    expect(approvalBranch.indexOf("await this.persist(checkpoint)"))
      .toBeLessThan(approvalBranch.indexOf('type: "waiting_approval"'));
  });
});
