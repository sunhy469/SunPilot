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

  test("selects a named automation skill for automation intent", async () => {
    const decision = await new ToolDecisionEngine({
      listSkills: async () => [
        {
          id: "sunpilot.automation:daily.close",
          name: "Daily Close",
          description: "Close the daily business checklist.",
          category: "automation",
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
            content: "run automation Daily Close",
            attachments: [],
          },
        },
        intent: {
          type: "automation_execution",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: ["sunpilot.automation:daily.close"],
          reason: "test",
        },
      },
      new AbortController().signal,
    );

    expect(decision).toEqual({
      type: "use_tool",
      reason: "Matched 1 skill(s) for intent 'automation_execution'",
      toolCalls: [
        expect.objectContaining({
          skillId: "sunpilot.automation:daily.close",
          arguments: {},
          permissions: [],
          riskLevel: "medium",
          requiresApproval: false,
          timeoutMs: 5_000,
        }),
      ],
    });
  });

  test("passes image attachments and URLs into search skill arguments", async () => {
    const decision = await new ToolDecisionEngine({
      listSkills: async () => [
        {
          id: "jaderoad:product.source.search1688",
          name: "搜索 1688 货源",
          description: "Search 1688 by product image or text query.",
          category: "custom",
          enabled: true,
          permissions: ["network.request"],
          defaultTimeoutMs: 5_000,
          maxTimeoutMs: 10_000,
          supportsAbort: true,
          idempotent: true,
          riskHints: { defaultRisk: "medium" },
        },
      ],
    }).decide(
      {
        context: {
          ...context,
          currentMessage: {
            id: "msg_user",
            content: "帮我搜索这件衣服的同款货源",
            attachments: [
              {
                id: "att_1",
                name: "clothes.png",
                type: "image/png",
                url: "http://jadeco.oss-cn-shanghai.aliyuncs.com/sunpilot/uploads/2026-06-15-07-50-17/1s9ug1_image.png",
              },
            ],
          },
        },
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: [],
          reason: "test",
        },
      },
      new AbortController().signal,
    );

    expect(decision).toEqual(
      expect.objectContaining({
        type: "use_tool",
        toolCalls: [
          expect.objectContaining({
            skillId: "jaderoad:product.source.search1688",
            arguments: expect.objectContaining({
              query: "帮我搜索这件衣服的同款货源",
              imageUrl:
                "http://jadeco.oss-cn-shanghai.aliyuncs.com/sunpilot/uploads/2026-06-15-07-50-17/1s9ug1_image.png",
              image_url:
                "http://jadeco.oss-cn-shanghai.aliyuncs.com/sunpilot/uploads/2026-06-15-07-50-17/1s9ug1_image.png",
              attachments: [
                expect.objectContaining({
                  id: "att_1",
                  type: "image/png",
                }),
              ],
            }),
          }),
        ],
      }),
    );
  });
});
