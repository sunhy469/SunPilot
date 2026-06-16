import { describe, expect, test } from "vitest";
import type {
  AgentPlan,
  AgentContext,
  AgentObservation,
  ToolCallSummary,
} from "../loop-types.js";
import { Replanner } from "./replanner.js";

function makeSkillList(skills: Array<Partial<{ id: string; category: string; riskHints: { defaultRisk: string } }>> = []) {
  return async () =>
    skills.map((s) => ({
      id: s.id ?? "filesystem.read",
      name: s.id ?? "Read File",
      description: `Skill: ${s.id}`,
      category: (s.category ?? "filesystem") as
        | "filesystem" | "shell" | "code" | "web" | "memory"
        | "artifact" | "automation" | "custom",
      enabled: true,
      permissions: ["filesystem.read"] as const,
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      supportsAbort: true,
      idempotent: true,
      inputSchema: undefined,
      riskHints: {
        defaultRisk: (s.riskHints?.defaultRisk ?? "low") as
          | "low" | "medium" | "high" | "critical",
        destructiveArgs: [],
        externalHosts: [],
      },
    }));
}

function makePlan(overrides: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "plan_test",
    runId: "run_test",
    goal: "Find product sources",
    summary: "Search for products",
    riskLevel: "medium",
    steps: [
      {
        id: "step_1",
        title: "Search",
        description: "Search 1688",
        type: "tool",
        skillId: "jaderoad:search",
        dependsOn: [],
        riskLevel: "medium",
      },
      {
        id: "step_2",
        title: "Reason",
        description: "Analyze results",
        type: "reasoning",
        dependsOn: ["step_1"],
        riskLevel: "low",
      },
      {
        id: "step_3",
        title: "Respond",
        description: "Respond to user",
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

function makeContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    runId: "run_test",
    conversationId: "conv_test",
    system: { persona: "test", rules: [], safety: [] },
    currentMessage: {
      id: "msg_1",
      content: "Find me product sources",
      attachments: [],
    },
    messages: [],
    memories: [],
    artifacts: [],
    toolResults: [],
    availableSkills: [],
    limits: { maxTokens: 8000, reservedForOutput: 1000, usedTokensEstimate: 10 },
    tokenEstimate: 10,
    ...overrides,
  };
}

describe("Replanner", () => {
  // ── tool_failed ────────────────────────────────────────────────────

  test("tool_failed: replaces failed step with alternative skill in same category", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList([
        { id: "jaderoad:search", category: "web", riskHints: { defaultRisk: "medium" } },
        { id: "jaderoad:search_v2", category: "web", riskHints: { defaultRisk: "medium" } },
      ]),
    });

    const plan = makePlan();
    const failedCall: ToolCallSummary = {
      id: "tc_fail",
      skillId: "jaderoad:search",
      name: "Search",
      status: "failed",
      summary: "Connection refused to upstream API",
    };

    const result = await replanner.replan({
      trigger: "tool_failed",
      originalPlan: plan,
      context: makeContext(),
      failedToolCalls: [failedCall],
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.changed).toBe(true);
    expect(result.modifiedSteps).toContain("step_1");
    expect(result.summary).toContain("Search");
  });

  test("tool_failed: repairable failure keeps step with retry note", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList([
        { id: "jaderoad:search", category: "web", riskHints: { defaultRisk: "medium" } },
      ]),
    });

    const plan = makePlan();
    const failedCall: ToolCallSummary = {
      id: "tc_timeout",
      skillId: "jaderoad:search",
      name: "Search",
      status: "failed",
      summary: "timeout waiting for response",
    };

    const result = await replanner.replan({
      trigger: "tool_failed",
      originalPlan: plan,
      context: makeContext(),
      failedToolCalls: [failedCall],
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.changed).toBe(true);
    // Should have a retry step
    const toolSteps = result.plan.steps.filter((s) => s.type === "tool");
    expect(toolSteps.length).toBeGreaterThanOrEqual(1);
  });

  // ── goal_changed ───────────────────────────────────────────────────

  test("goal_changed: keeps completed steps, rewrites pending ones", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList([
        { id: "jaderoad:detail", category: "web", riskHints: { defaultRisk: "low" } },
      ]),
    });

    const plan = makePlan();
    const observation: AgentObservation = {
      runId: "run_test",
      toolCalls: [
        {
          id: "tc_1",
          skillId: "jaderoad:search",
          name: "Search",
          status: "completed",
          summary: "Found 100 results",
        },
      ],
      artifacts: [],
      summary: "Search completed",
    };

    const result = await replanner.replan({
      trigger: "goal_changed",
      originalPlan: plan,
      context: makeContext({
        currentMessage: {
          id: "msg_2",
          content: "Now get me product details instead",
          attachments: [],
        },
      }),
      observation,
      newGoal: "Get product details",
      iteration: 2,
      maxIterations: 5,
    });

    expect(result.changed).toBe(true);
    expect(result.summary).toContain("Goal changed");
  });

  // ── approval_rejected ──────────────────────────────────────────────

  test("approval_rejected: replaces rejected step with low-risk alternative", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList([
        { id: "shell.execute", category: "shell", riskHints: { defaultRisk: "high" } },
        { id: "filesystem.read", category: "shell", riskHints: { defaultRisk: "low" } },
      ]),
    });

    const plan = makePlan({
      steps: [
        {
          id: "step_1",
          title: "Run shell",
          description: "Execute shell command",
          type: "tool",
          skillId: "shell.execute",
          dependsOn: [],
          riskLevel: "high",
        },
        {
          id: "step_2",
          title: "Respond",
          description: "Respond",
          type: "response",
          dependsOn: ["step_1"],
          riskLevel: "low",
        },
      ],
    });

    const result = await replanner.replan({
      trigger: "approval_rejected",
      originalPlan: plan,
      context: makeContext(),
      rejectedSkillId: "shell.execute",
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.changed).toBe(true);
    expect(result.removedSteps).toContain("step_1");
  });

  test("approval_rejected: adds explanation step when no alternative exists", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList([
        { id: "shell.execute", category: "shell", riskHints: { defaultRisk: "high" } },
      ]),
    });

    const plan = makePlan({
      steps: [
        {
          id: "step_1",
          title: "Run shell",
          description: "Execute shell command",
          type: "tool",
          skillId: "shell.execute",
          dependsOn: [],
          riskLevel: "high",
        },
      ],
    });

    const result = await replanner.replan({
      trigger: "approval_rejected",
      originalPlan: plan,
      context: makeContext(),
      rejectedSkillId: "shell.execute",
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.changed).toBe(true);
    // Should have added a reasoning step to explain the situation
    const reasoningSteps = result.plan.steps.filter((s) => s.type === "reasoning");
    expect(reasoningSteps.length).toBeGreaterThan(0);
  });

  // ── tool_result_insufficient ───────────────────────────────────────

  test("tool_result_insufficient: adds verification steps for missing info", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList([
        { id: "jaderoad:detail", category: "web", riskHints: { defaultRisk: "low" } },
      ]),
    });

    const plan = makePlan();
    const result = await replanner.replan({
      trigger: "tool_result_insufficient",
      originalPlan: plan,
      context: makeContext(),
      reflection: {
        goalAchieved: false,
        confidence: 0.4,
        summary: "Need more detail",
        nextAction: "continue",
        missingInfo: ["detail", "shipping"],
      },
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.changed).toBe(true);
    expect(result.addedSteps.length).toBeGreaterThan(0);
    expect(result.summary).toContain("verification step");
  });

  // ── missing_parameters ─────────────────────────────────────────────

  test("missing_parameters: inserts clarification step before tool", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList([
        { id: "skill.a", riskHints: { defaultRisk: "low" } },
      ]),
    });

    const plan = makePlan();
    const result = await replanner.replan({
      trigger: "missing_parameters",
      originalPlan: plan,
      context: makeContext(),
      reflection: {
        goalAchieved: false,
        confidence: 0.3,
        summary: "Missing required params",
        nextAction: "ask_user",
        missingInfo: ["imageUrl"],
      },
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.changed).toBe(true);
    expect(result.addedSteps.length).toBeGreaterThan(0);
    const clarStep = result.plan.steps.find((s) => s.id === result.addedSteps[0]?.id);
    expect(clarStep?.description).toContain("imageUrl");
  });

  // ── max_iterations_approaching ─────────────────────────────────────

  test("max_iterations_approaching: summarizes unfinished steps", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList([
        { id: "jaderoad:search", category: "web", riskHints: { defaultRisk: "medium" } },
        { id: "jaderoad:detail", category: "web", riskHints: { defaultRisk: "low" } },
      ]),
    });

    const plan = makePlan({
      steps: [
        {
          id: "step_1",
          title: "Search",
          description: "Search 1688",
          type: "tool",
          skillId: "jaderoad:search",
          dependsOn: [],
          riskLevel: "medium",
        },
        {
          id: "step_2",
          title: "Get details",
          description: "Get product details",
          type: "tool",
          skillId: "jaderoad:detail",
          dependsOn: ["step_1"],
          riskLevel: "low",
        },
        {
          id: "step_3",
          title: "Respond",
          description: "Respond",
          type: "response",
          dependsOn: ["step_2"],
          riskLevel: "low",
        },
      ],
    });

    const observation: AgentObservation = {
      runId: "run_test",
      toolCalls: [
        {
          id: "tc_search",
          skillId: "jaderoad:search",
          name: "Search",
          status: "completed",
          summary: "Found results",
        },
      ],
      artifacts: [],
      summary: "Search done",
    };

    const result = await replanner.replan({
      trigger: "max_iterations_approaching",
      originalPlan: plan,
      context: makeContext(),
      observation,
      iteration: 4,
      maxIterations: 5,
    });

    expect(result.changed).toBe(true);
    expect(result.removedSteps).toContain("step_2");
    expect(result.summary).toContain("unfinished");
  });

  // ── No-op cases ────────────────────────────────────────────────────

  test("returns unchanged when no failed tool calls for tool_failed", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList(),
    });
    const plan = makePlan();
    const result = await replanner.replan({
      trigger: "tool_failed",
      originalPlan: plan,
      context: makeContext(),
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.changed).toBe(false);
  });

  test("returns unchanged when rejected skill not in plan", async () => {
    const replanner = new Replanner({
      listSkills: makeSkillList(),
    });
    const plan = makePlan();
    const result = await replanner.replan({
      trigger: "approval_rejected",
      originalPlan: plan,
      context: makeContext(),
      rejectedSkillId: "nonexistent.skill",
      iteration: 1,
      maxIterations: 5,
    });

    expect(result.changed).toBe(false);
  });
});
