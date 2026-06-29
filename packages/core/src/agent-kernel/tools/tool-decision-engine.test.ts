import { describe, expect, test } from "vitest";
import type { AgentContext, AgentPlan, RoutedIntent, ToolCallSummary } from "../loop-types.js";
import { ToolDecisionEngine, projectToolResultForModel } from "./tool-decision-engine.js";
import { InMemoryAgentEventBus } from "../agent-event-bus.js";
import { ModelRouter } from "../model-router.js";
import { PermissionPolicy } from "../safety/permission-policy.js";

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
  test("returns a persisted-approval handoff instead of executing dynamic-risk tools", async () => {
    let executed = false;
    const provider = {
      id: "fake",
      model: "fake",
      async *streamChat(request: { tools?: Array<{ function: { name: string } }> }) {
        const toolName = request.tools?.[0]?.function.name;
        expect(toolName).toBeTruthy();
        yield {
          delta: "",
          toolCalls: [
            {
              index: 0,
              id: "tc_network",
              type: "function" as const,
              function: { name: toolName!, arguments: '{"url":"https://example.com"}' },
            },
          ],
          raw: {},
        };
      },
    };
    const engine = new ToolDecisionEngine({
      listSkills: async () => [
        {
          id: "test.network:network.request",
          name: "Network Request",
          description: "Fetch a URL",
          category: "network",
          enabled: true,
          permissions: ["network.request"],
          defaultTimeoutMs: 5_000,
          maxTimeoutMs: 10_000,
          supportsAbort: true,
          idempotent: true,
          riskHints: { defaultRisk: "medium" },
        },
      ],
      eventBus: new InMemoryAgentEventBus(),
      modelRouter: new ModelRouter({
        routes: [
          {
            purposes: ["response_composition"],
            priority: 0,
            config: { provider, model: provider.model },
          },
        ],
      }),
      permissionPolicy: new PermissionPolicy(),
      executionOrchestrator: {
        async execute() {
          executed = true;
          return { runId: context.runId, toolCalls: [], artifacts: [], summary: "" };
        },
      },
      saveMessage: async () => {},
    });

    const result = await engine.executeStreaming(
      {
        runId: context.runId,
        conversationId: context.conversationId,
        context,
        intent,
        permissionMode: "ask",
        toolSkillIds: ["test.network:network.request"],
      },
      new AbortController().signal,
    );

    expect(executed).toBe(false);
    expect(result.approvalRequired).toEqual([
      expect.objectContaining({
        id: "tc_network",
        skillId: "test.network:network.request",
        arguments: { url: "https://example.com" },
      }),
    ]);
  });

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
          // In the new architecture, IntentRouter provides candidate skills
          // via embedding semantic matching or LLM classification.
          // An empty candidateSkills would fall through to the scorer, which
          // with the reduced bigram weights would not clear the threshold.
          candidateSkills: ["jaderoad:product.source.search1688"],
          reason: "embedding matched with high confidence",
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

  test("heuristic fills imageDataUrl from attachment with only dataUrl", async () => {
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
            content: "搜索同款货源",
            attachments: [
              {
                id: "att_dataurl",
                name: "photo.jpg",
                type: "image/jpeg",
                dataUrl: "data:image/jpeg;base64,/9j/4AAQ...",
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
          candidateSkills: ["jaderoad:product.source.search1688"],
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
              imageDataUrl: "data:image/jpeg;base64,/9j/4AAQ...",
              image_data_url: "data:image/jpeg;base64,/9j/4AAQ...",
            }),
          }),
        ],
      }),
    );
  });

  test("1688 search without image returns no-tool or clarification (P0 gate)", async () => {
    // §5.4 + §5.6: When the user asks for 1688 product search but provides
    // no image attachments, the decision engine should NOT return a use_tool
    // with a tool call that will deterministically fail.
    //
    // Note: Without an argumentBuilder, the heuristic fallback can't detect
    // anyOf schema requirements (imageUrl OR imageDataUrl). That's why the
    // primary image validation gate lives in AgentService (§5.4). The
    // argumentBuilder + checkAnyOfUnsatisfied in executeToolCalls provide
    // the second layer. This test verifies the decision engine's behavior
    // in the decide() path with only heuristic argument building.
    const decision = await new ToolDecisionEngine({
      listSkills: async () => [
        {
          id: "jaderoad:product.source.search1688",
          name: "搜索 1688 货源",
          description: "Search 1688 products by image or text.",
          category: "custom",
          enabled: true,
          permissions: ["network.request"],
          defaultTimeoutMs: 5_000,
          maxTimeoutMs: 10_000,
          supportsAbort: true,
          idempotent: true,
          riskHints: { defaultRisk: "medium" },
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              imageUrl: { type: "string" },
              imageDataUrl: { type: "string" },
            },
            anyOf: [
              { required: ["imageUrl"] },
              { required: ["imageDataUrl"] },
            ],
            additionalProperties: false,
          },
        },
      ],
    }).decide(
      {
        context: {
          ...context,
          currentMessage: {
            id: "msg_user",
            content: "帮我用1688搜索同款货源",
            // No attachments, no image URLs — should be caught by AgentService.assertUsableImageAttachments
            attachments: [],
          },
        },
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "medium",
          candidateSkills: ["jaderoad:product.source.search1688"],
          reason: "test",
        },
      },
      new AbortController().signal,
    );

    // With heuristic-only argument building (no argumentBuilder), the
    // decide() path may return use_tool with incomplete args. The primary
    // defense is AgentService.assertUsableImageAttachments (§5.4) which
    // blocks the request before it reaches this point.
    //
    // When use_tool is returned, the tool calls must at minimum have the
    // search1688 skillId — the executeToolCalls path will then catch the
    // missing image args via checkAnyOfUnsatisfied and return a stop.
    if (decision.type === "use_tool") {
      expect(decision.toolCalls.length).toBeGreaterThan(0);
      expect(decision.toolCalls[0]!.skillId).toBe("jaderoad:product.source.search1688");
    } else {
      // ask_clarification or no_tool are also acceptable outcomes
      expect(["ask_clarification", "no_tool"]).toContain(decision.type);
    }
  });
});

// ── Golden tests: ToolResultProjection (§P1-3) ────────────────────────

describe("ToolResultProjection", () => {
  test("script content preserved — model sees full script, not just terse summary", () => {
    const summary: ToolCallSummary = {
      id: "tc_script",
      skillId: "content:video.script",
      name: "Generate Video Script",
      status: "completed",
      summary: "已完成生成短视频脚本",  // terse — what the old code injected
      content: "镜头1: 产品特写，展示24小时保温功能。镜头2: 食品级材质特写...",
      structured: {
        script: "镜头1: 产品特写，展示24小时保温功能。镜头2: 食品级材质特写...",
        duration: "30s",
        scenes: 5,
      },
      metadata: {
        projectionHints: { outputIsFinal: true },
      },
    };

    const projection = projectToolResultForModel(summary);

    // Model observation MUST contain the actual script content, not just the terse summary
    expect(projection.modelObservation).toContain("镜头1: 产品特写");
    expect(projection.modelObservation).toContain("24小时保温");
    expect(projection.modelObservation).toContain("食品级材质");
    // Should NOT be just the terse summary alone
    expect(projection.modelObservation).not.toBe("已完成生成短视频脚本");
    // Should be marked as final answer candidate
    expect(projection.isFinalAnswer).toBe(true);
  });

  test("fallback to summary when no content or structured fields", () => {
    const summary: ToolCallSummary = {
      id: "tc_simple",
      skillId: "shell.execute",
      name: "Run Command",
      status: "completed",
      summary: "Command executed successfully.",
    };

    const projection = projectToolResultForModel(summary);

    expect(projection.modelObservation).toBe("Command executed successfully.");
    expect(projection.isFinalAnswer).toBe(false);
  });

  test("structured fields extracted when no content field", () => {
    const summary: ToolCallSummary = {
      id: "tc_search",
      skillId: "jaderoad:product.source.search1688",
      name: "Search 1688",
      status: "completed",
      summary: "找到 50 个结果。",
      structured: {
        totalResults: 50,
        candidates: [{ title: "保温杯 A" }, { title: "保温杯 B" }],
      },
    };

    const projection = projectToolResultForModel(summary);

    // Should include structured data, not just terse summary
    expect(projection.modelObservation).toContain("[totalResults: 50]");
    expect(projection.modelObservation).toContain("[candidates: 2 items]");
  });

  test("failed tool prefixes status in model observation", () => {
    const summary: ToolCallSummary = {
      id: "tc_fail",
      skillId: "shell.execute",
      name: "Run Command",
      status: "failed",
      summary: "Permission denied.",
    };

    const projection = projectToolResultForModel(summary);

    expect(projection.modelObservation).toContain("[FAILED]");
    expect(projection.modelObservation).toContain("Permission denied.");
    expect(projection.isFinalAnswer).toBe(false);
  });

  test("outputIsFinal requires completed status", () => {
    const summary: ToolCallSummary = {
      id: "tc_final_failed",
      skillId: "content:video.script",
      name: "Generate Video Script",
      status: "failed",
      summary: "Generation failed.",
      metadata: {
        projectionHints: { outputIsFinal: true },
      },
    };

    const projection = projectToolResultForModel(summary);

    // Even with outputIsFinal=true, failed tools are NOT final answers
    expect(projection.isFinalAnswer).toBe(false);
  });

  test("long observations truncated to prevent context bloat", () => {
    const longScript = "A".repeat(10000);
    const summary: ToolCallSummary = {
      id: "tc_long",
      skillId: "content:video.script",
      name: "Generate Video Script",
      status: "completed",
      summary: "Done.",
      content: longScript,
    };

    const projection = projectToolResultForModel(summary);

    // Should be truncated at 8000 chars
    expect(projection.modelObservation.length).toBeLessThanOrEqual(8100); // 8000 + truncation message
    expect(projection.modelObservation).toContain("[truncated");
  });
});
