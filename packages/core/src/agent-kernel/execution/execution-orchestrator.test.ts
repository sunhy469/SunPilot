import { describe, expect, test } from "vitest";
import { InMemoryAgentEventBus } from "../agent-event-bus.js";
import type { AgentContext } from "../loop-types.js";
import { ExecutionOrchestrator } from "./execution-orchestrator.js";

const context: AgentContext = {
  runId: "run_1",
  conversationId: "conv_1",
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: { id: "msg_1", content: "write report", attachments: [] },
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

describe("ExecutionOrchestrator", () => {
  test("emits artifact.created events for tool artifacts", async () => {
    const eventBus = new InMemoryAgentEventBus();
    const events: string[] = [];
    eventBus.subscribe((event) => events.push(event.type));
    const orchestrator = new ExecutionOrchestrator({
      eventBus,
      toolExecutor: {
        async execute() {
          return {
            status: "completed",
            summary: "created report",
            artifacts: [
              {
                id: "artifact_1",
                name: "report.md",
                type: "markdown",
                version: 2,
              },
            ],
          };
        },
      },
    });

    const result = await orchestrator.execute(
      {
        runId: "run_1",
        context,
        intent: {
          type: "artifact_generation",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: ["artifact.write"],
          reason: "test",
        },
        decision: {
          type: "use_tool",
          reason: "test",
          toolCalls: [
            {
              id: "tool_1",
              skillId: "artifact.write",
              name: "Write Artifact",
              arguments: {},
              permissions: ["artifact.write"],
              reason: "test",
              riskLevel: "low",
              requiresApproval: false,
              timeoutMs: 1_000,
            },
          ],
        },
      },
      new AbortController().signal,
    );

    expect(result.artifacts).toEqual([
      expect.objectContaining({ id: "artifact_1", version: 2 }),
    ]);
    expect(events).toContain("agent.tool.completed");
    expect(events).toContain("agent.artifact.created");
  });
});
