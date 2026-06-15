import { describe, expect, test } from "vitest";
import type {
  AgentContext,
  AgentObservation,
  RoutedIntent,
} from "../loop-types.js";
import { BasicReflectionEngine } from "./basic-reflection-engine.js";

const context: AgentContext = {
  runId: "run_reflect",
  conversationId: "conv_reflect",
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: { id: "msg_user", content: "run tool", attachments: [] },
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
  type: "diagnostics",
  confidence: 0.9,
  requiresPlanning: true,
  requiresTool: true,
  requiresApproval: false,
  riskLevel: "medium",
  candidateSkills: [],
  reason: "test",
};

describe("BasicReflectionEngine", () => {
  test("marks observations with failed tool calls as not achieved", async () => {
    const observation: AgentObservation = {
      runId: context.runId,
      artifacts: [],
      summary: "failed",
      toolCalls: [
        {
          id: "tool_1",
          skillId: "filesystem.read",
          name: "Read File",
          status: "failed",
          summary: "missing file",
        },
      ],
    };

    const result = await new BasicReflectionEngine().reflect(
      { context, intent, observation },
      new AbortController().signal,
    );

    expect(result.goalAchieved).toBe(false);
    expect(result.nextAction).toBe("respond");
    expect(result.stopReason).toBe("tool_failed");
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.summary).toContain("Read File");
  });
});
