import { describe, expect, test } from "vitest";
import type { AgentContext, RoutedIntent } from "../loop-types.js";
import { RuleBasedPlanner } from "./rule-based-planner.js";

const context: AgentContext = {
  runId: "run_plan",
  conversationId: "conv_plan",
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: {
    id: "msg_user",
    content: "analyze the project",
    attachments: [],
  },
  messages: [],
  memories: [],
  artifacts: [],
  toolResults: [],
  availableSkills: [
    {
      id: "filesystem.read",
      name: "Read File",
      description: "Read workspace files",
      category: "filesystem",
    },
  ],
  limits: {
    maxTokens: 8_000,
    reservedForOutput: 1_000,
    usedTokensEstimate: 10,
  },
  tokenEstimate: 10,
};

describe("RuleBasedPlanner", () => {
  test("builds auditable tool, reasoning, and response steps", async () => {
    const intent: RoutedIntent = {
      type: "project_analysis",
      confidence: 0.9,
      requiresPlanning: true,
      requiresTool: true,
      requiresApproval: false,
      riskLevel: "low",
      candidateSkills: ["filesystem.read"],
      reason: "test",
    };

    const plan = await new RuleBasedPlanner().createPlan(
      context,
      intent,
      new AbortController().signal,
    );

    expect(plan).toMatchObject({
      runId: context.runId,
      goal: "analyze the project",
      riskLevel: "low",
      requiresApproval: false,
      expectedArtifacts: [],
    });
    expect(plan.steps).toEqual([
      expect.objectContaining({
        type: "tool",
        skillId: "filesystem.read",
        dependsOn: [],
      }),
      expect.objectContaining({
        type: "reasoning",
        dependsOn: [plan.steps[0]!.id],
      }),
      expect.objectContaining({
        type: "response",
        dependsOn: [plan.steps[1]!.id],
      }),
    ]);
  });
});
