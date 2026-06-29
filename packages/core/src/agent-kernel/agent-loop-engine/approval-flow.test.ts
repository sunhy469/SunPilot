import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { InMemoryAgentEventBus } from "../agent-event-bus.js";
import { RepositoryApprovalRequestService } from "../persistence/repository-approval-request-service.js";
import { RepositoryRunStateManager } from "../persistence/repository-run-state-manager.js";
import type { AgentContext, AgentLoopInput, RoutedIntent } from "../loop-types.js";
import { ApprovalFlowCoordinator } from "./approval-flow.js";

describe("ApprovalFlowCoordinator", () => {
  test("creates one approval that explicitly covers a multi-tool batch", async () => {
    const db = new InMemoryDatabaseContext();
    const runStateManager = new RepositoryRunStateManager(db);
    const eventBus = new InMemoryAgentEventBus();
    const input: AgentLoopInput = {
      runId: "run_batch",
      conversationId: "conv_batch",
      userMessageId: "msg_user",
      message: "perform both actions",
      mode: "agent",
      client: { source: "web" },
    };
    await runStateManager.createRun(input);
    await runStateManager.markStatus(input.runId, "context_building");
    await runStateManager.markStatus(input.runId, "intent_routing");
    await runStateManager.markStatus(input.runId, "tool_deciding");
    const coordinator = new ApprovalFlowCoordinator({
      eventBus,
      runStateManager,
      approvalRequestService: new RepositoryApprovalRequestService(db),
      saveMessage: async () => {},
    } as any);

    const result = await coordinator.runApprovalForToolCalls(
      input,
      {} as AgentContext,
      {} as RoutedIntent,
      undefined,
      {
        type: "use_tool",
        reason: "batch",
        toolCalls: [
          {
            id: "tc_1",
            skillId: "skill.one",
            name: "One",
            arguments: { first: true },
            permissions: ["network.request"],
            reason: "batch",
            riskLevel: "medium",
            requiresApproval: true,
            timeoutMs: 1_000,
          },
          {
            id: "tc_2",
            skillId: "skill.two",
            name: "Two",
            arguments: { second: true },
            permissions: ["shell.execute"],
            reason: "batch",
            riskLevel: "high",
            requiresApproval: true,
            timeoutMs: 1_000,
          },
        ],
      },
      "msg_assistant",
      new AbortController().signal,
    );

    expect(result.status).toBe("waiting_approval");
    const approvals = await db.approvals.list({ status: "pending" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({
      runId: input.runId,
      risk: "high",
      requestedAction: {
        skillId: "skill.one",
        permissions: ["network.request", "shell.execute"],
        arguments: {
          toolCalls: [
            expect.objectContaining({ id: "tc_1", skillId: "skill.one" }),
            expect.objectContaining({ id: "tc_2", skillId: "skill.two" }),
          ],
        },
      },
    });
  });
});
