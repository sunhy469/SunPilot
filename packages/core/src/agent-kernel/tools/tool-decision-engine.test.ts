import { describe, expect, test } from "vitest";
import type { AgentContext, AgentPlan, RoutedIntent } from "../loop-types.js";
import { ToolDecisionEngine } from "./tool-decision-engine.js";

const context: AgentContext = {
  runId: "run_tools",
  conversationId: "conv_tools",
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: { id: "msg_user", content: "run build", attachments: [] },
  messages: [],
  memories: [],
  artifacts: [],
  toolResults: [],
  availableSkills: [],
  limits: {
    maxTokens: 8_000,
    reservedForOutput: 1_000,
    usedTokensEstimate: 10,
  },
  tokenEstimate: 10,
};

const intent: RoutedIntent = {
  type: "shell_operation",
  confidence: 0.9,
  requiresPlanning: true,
  requiresTool: true,
  requiresApproval: true,
  riskLevel: "high",
  candidateSkills: ["shell.execute"],
  reason: "test",
};

describe("ToolDecisionEngine", () => {
  test("enriches planned tool steps with manifest permissions", async () => {
    const plan: AgentPlan = {
      id: "plan_1",
      runId: context.runId,
      goal: "run build",
      summary: "Run build",
      riskLevel: "high",
      expectedArtifacts: [],
      requiresApproval: true,
      steps: [
        {
          id: "step_1",
          title: "Execute Shell",
          description: "Run build command",
          type: "tool",
          skillId: "shell.execute",
          dependsOn: [],
          input: { command: "pnpm build" },
          riskLevel: "medium",
        },
      ],
    };

    const decision = await new ToolDecisionEngine({
      listSkills: async () => [
        {
          id: "shell.execute",
          name: "Execute Shell",
          description: "Execute a shell command",
          category: "shell",
          enabled: true,
          permissions: ["shell.execute"],
          defaultTimeoutMs: 5_000,
          maxTimeoutMs: 10_000,
          supportsAbort: true,
          idempotent: false,
          riskHints: { defaultRisk: "high" },
        },
      ],
    }).decide({ context, intent, plan }, new AbortController().signal);

    expect(decision).toEqual({
      type: "use_tool",
      reason: "Executing 1 tool step(s) from plan",
      toolCalls: [
        expect.objectContaining({
          skillId: "shell.execute",
          arguments: { command: "pnpm build" },
          permissions: ["shell.execute"],
          riskLevel: "high",
          requiresApproval: true,
          timeoutMs: 5_000,
        }),
      ],
    });
  });

  test("selects a named workflow skill for workflow intent", async () => {
    const decision = await new ToolDecisionEngine({
      listSkills: async () => [
        {
          id: "workflow.daily.close",
          name: "Daily Close",
          description: "Close the daily business checklist.",
          category: "workflow",
          enabled: true,
          permissions: [],
          defaultTimeoutMs: 5_000,
          maxTimeoutMs: 10_000,
          supportsAbort: false,
          idempotent: false,
          riskHints: { defaultRisk: "medium" },
        },
      ],
    }).decide(
      {
        context: {
          ...context,
          currentMessage: {
            id: "msg_user",
            content: "run workflow Daily Close",
            attachments: [],
          },
        },
        intent: {
          type: "workflow_execution",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: ["workflow"],
          reason: "test",
        },
      },
      new AbortController().signal,
    );

    expect(decision).toEqual({
      type: "use_tool",
      reason: "Matched 1 workflow(s) for intent 'workflow_execution'",
      toolCalls: [
        expect.objectContaining({
          skillId: "workflow.daily.close",
          arguments: { message: "run workflow Daily Close" },
          permissions: [],
          riskLevel: "medium",
          requiresApproval: false,
          timeoutMs: 5_000,
        }),
      ],
    });
  });
});
