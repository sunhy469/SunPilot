import { describe, expect, test } from "vitest";
import type { AgentPlan } from "../loop-types.js";
import { PlanValidator } from "./plan-validator.js";

// Stub skill list for tests
function makeSkillList(skills: Array<Partial<{ id: string; riskHints: { defaultRisk: string }; inputSchema: Record<string, unknown> }>> = []) {
  return async () =>
    skills.map((s) => ({
      id: s.id ?? "filesystem.read",
      name: "Read File",
      description: "Read workspace files",
      category: "filesystem" as const,
      enabled: true,
      permissions: ["filesystem.read"] as const,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      supportsAbort: true,
      idempotent: true,
      inputSchema: s.inputSchema,
      riskHints: {
        defaultRisk: (s.riskHints?.defaultRisk ?? "low") as "low" | "medium" | "high" | "critical",
        destructiveArgs: [],
        externalHosts: [],
      },
    }));
}

function makePlan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "plan_test",
    runId: "run_test",
    goal: "Find and analyze product sources",
    summary: "Search 1688 for product sources and analyze results",
    riskLevel: "medium",
    steps: [
      {
        id: "step_1",
        title: "Search 1688",
        description: "Search for product sources on 1688",
        type: "tool",
        skillId: "jaderoad:product.source.search1688",
        dependsOn: [],
        riskLevel: "medium",
      },
      {
        id: "step_2",
        title: "Reason about results",
        description: "Analyze search results",
        type: "reasoning",
        dependsOn: ["step_1"],
        riskLevel: "low",
      },
      {
        id: "step_3",
        title: "Compose response",
        description: "Return results to user",
        type: "response",
        dependsOn: ["step_2"],
        riskLevel: "low",
      },
    ],
    expectedArtifacts: [],
    requiresApproval: false,
    ...overrides,
  };
}

describe("PlanValidator", () => {
  test("valid plan passes all checks", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList([
        { id: "jaderoad:product.source.search1688", riskHints: { defaultRisk: "medium" } },
      ]),
    });
    const plan = makePlan();
    const result = await validator.validate(plan);

    expect(result.valid).toBe(true);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(result.executableSteps).toEqual(["step_1", "step_2", "step_3"]);
    expect(result.blockedSteps).toHaveLength(0);
  });

  test("detects missing skillId on tool step", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList(),
    });
    const plan = makePlan({
      steps: [
        {
          id: "step_1",
          title: "Bad tool step",
          description: "No skill id",
          type: "tool",
          dependsOn: [],
          riskLevel: "low",
        },
      ],
    });
    const result = await validator.validate(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "MISSING_SKILL_ID",
        severity: "error",
      }),
    );
  });

  test("detects skill not available", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList([
        { id: "other.skill", riskHints: { defaultRisk: "low" } },
      ]),
    });
    const plan = makePlan();
    const result = await validator.validate(plan);

    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "SKILL_NOT_AVAILABLE",
        severity: "error",
      }),
    );
    expect(result.blockedSteps).toContain("step_1");
  });

  test("detects circular dependencies", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList([
        { id: "skill.a", riskHints: { defaultRisk: "low" } },
        { id: "skill.b", riskHints: { defaultRisk: "low" } },
      ]),
    });
    const plan = makePlan({
      steps: [
        {
          id: "step_1",
          title: "Step A",
          description: "First step",
          type: "tool",
          skillId: "skill.a",
          dependsOn: ["step_2"],
          riskLevel: "low",
        },
        {
          id: "step_2",
          title: "Step B",
          description: "Second step",
          type: "tool",
          skillId: "skill.b",
          dependsOn: ["step_1"],
          riskLevel: "low",
        },
      ],
    });

    const result = await validator.validate(plan);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "CIRCULAR_DEPENDENCY",
        severity: "error",
      }),
    );
  });

  test("detects dangling dependencies", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList([
        { id: "skill.a", riskHints: { defaultRisk: "low" } },
      ]),
    });
    const plan = makePlan({
      steps: [
        {
          id: "step_1",
          title: "Step A",
          description: "First step",
          type: "tool",
          skillId: "skill.a",
          dependsOn: ["nonexistent_step"],
          riskLevel: "low",
        },
      ],
    });

    const result = await validator.validate(plan);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "DANGLING_DEPENDENCY",
        severity: "error",
      }),
    );
  });

  test("detects high risk steps without plan approval", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList([
        { id: "skill.a", riskHints: { defaultRisk: "high" } },
      ]),
    });
    const plan = makePlan({
      requiresApproval: false,
      steps: [
        {
          id: "step_1",
          title: "Risky step",
          description: "High risk operation",
          type: "tool",
          skillId: "skill.a",
          dependsOn: [],
          riskLevel: "high",
        },
      ],
    });

    const result = await validator.validate(plan);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "HIGH_RISK_NO_APPROVAL",
        severity: "warning",
      }),
    );
    // Still valid (warning, not error)
    expect(result.valid).toBe(true);
  });

  test("detects risk downgrade vs skill default", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList([
        { id: "skill.a", riskHints: { defaultRisk: "high" } },
      ]),
    });
    const plan = makePlan({
      steps: [
        {
          id: "step_1",
          title: "Underrated step",
          description: "Should be high risk",
          type: "tool",
          skillId: "skill.a",
          dependsOn: [],
          riskLevel: "low",
        },
      ],
    });

    const result = await validator.validate(plan);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "RISK_DOWNGRADE",
        severity: "warning",
      }),
    );
  });

  test("detects missing required input fields from schema", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList([
        {
          id: "skill.a",
          riskHints: { defaultRisk: "low" },
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              imageUrl: { type: "string" },
            },
            required: ["query", "imageUrl"],
          },
        },
      ]),
    });
    const plan = makePlan({
      steps: [
        {
          id: "step_1",
          title: "Search without query",
          description: "Missing required input",
          type: "tool",
          skillId: "skill.a",
          dependsOn: [],
          input: {},
          riskLevel: "low",
        },
      ],
    });

    const result = await validator.validate(plan);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "MISSING_REQUIRED_INPUT",
        severity: "warning",
        message: expect.stringContaining("query"),
      }),
    );
  });

  test("empty plan goal triggers warning", async () => {
    const validator = new PlanValidator({
      listSkills: makeSkillList(),
    });
    const plan = makePlan({ goal: "" });
    const result = await validator.validate(plan);

    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "EMPTY_GOAL",
        severity: "warning",
      }),
    );
  });
});
