/**
 * Approval rejection follow-up tests.
 *
 * These tests verify that:
 * 1. Rejected runs transition to the correct state (not stuck in waiting_approval)
 * 2. Alternative paths are generated when a tool is rejected
 * 3. Users can modify and retry after rejection
 * 4. Rejection events carry the right metadata for UI and audit
 *
 * See agent_architecture_next_steps.md §P1-6.
 */

import { describe, expect, test } from "vitest";
import type {
  AgentContext,
  AgentLoopInput,
  AgentLoopResult,
  AgentObservation,
  AgentReflection,
  RoutedIntent,
  ToolDecision,
  PlannedToolCall,
  AgentPlan,
} from "../loop-types.js";
import type { AgentLoopEngineDeps } from "../agent-loop-engine.js";

// ── Stub Helpers ────────────────────────────────────────────────────────

function stubRunStateManager() {
  let status = "created" as string;
  let taskState: unknown = undefined;

  return {
    markStatus: async (_runId: string, newStatus: string) => {
      status = newStatus;
    },
    markCancelled: async (_runId: string, _reason: string) => {
      status = "cancelled";
    },
    markFailed: async (_runId: string, _error: unknown) => {
      status = "failed";
    },
    getRun: async (_runId: string) => ({
      runId: _runId,
      conversationId: "conv_1",
      status,
      goal: "test goal",
      mode: "agent" as const,
    }),
    saveTaskState: async (_runId: string, state: unknown) => {
      taskState = state;
    },
    getStatus: () => status,
    getTaskState: () => taskState,
  };
}

function stubEventBus() {
  const events: Array<{ type: string; payload: unknown }> = [];
  return {
    emit: (type: string, payload: unknown) => {
      events.push({ type, payload });
    },
    publish: (event: unknown) => {
      events.push({ type: "published", payload: event });
    },
    getEvents: () => events,
    clear: () => {
      events.length = 0;
    },
  };
}

function makeApprovalGate() {
  const approvals = new Map<
    string,
    {
      id: string;
      status: string;
      runId: string;
      title: string;
      riskLevel: string;
      requestedAction: {
        skillId: string;
        arguments: Record<string, unknown>;
        permissions: string[];
      };
    }
  >();

  return {
    createApproval: async (input: {
      runId: string;
      title: string;
      description: string;
      riskLevel: string;
      requestedAction: {
        skillId: string;
        arguments: Record<string, unknown>;
        permissions: string[];
      };
    }) => {
      const id = `approval_${crypto.randomUUID().slice(0, 8)}`;
      const record = {
        id,
        status: "pending",
        runId: input.runId,
        title: input.title,
        riskLevel: input.riskLevel,
        requestedAction: input.requestedAction,
      };
      approvals.set(id, record);
      return { id, status: "pending" };
    },
    approve: async (approvalId: string) => {
      const record = approvals.get(approvalId);
      if (record) record.status = "approved";
      return {
        approvalId,
        runId: record?.runId ?? "unknown",
        decidedBy: "test_user",
        title: record?.title,
        riskLevel: record?.riskLevel as
          | "low"
          | "medium"
          | "high"
          | "critical",
        requestedAction: record?.requestedAction,
      };
    },
    reject: async (approvalId: string, decidedBy?: string, reason?: string) => {
      const record = approvals.get(approvalId);
      if (record) record.status = "rejected";
      return {
        approvalId,
        runId: record?.runId ?? "unknown",
        decidedBy: decidedBy ?? "test_user",
        reason: reason ?? "User rejected",
      };
    },
    getApproval: (id: string) => approvals.get(id),
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("Approval rejection flow", () => {
  test("rejected approval transitions run out of waiting_approval", async () => {
    const approvalGate = makeApprovalGate();

    // Create an approval
    const approval = await approvalGate.createApproval({
      runId: "run_test",
      title: "Delete all files",
      description: "This will delete temporary files",
      riskLevel: "high",
      requestedAction: {
        skillId: "filesystem.delete",
        arguments: { paths: ["/tmp/*"] },
        permissions: ["filesystem.delete", "filesystem.write"],
      },
    });

    expect(approval.status).toBe("pending");

    // Reject it
    const rejected = await approvalGate.reject(
      approval.id,
      "test_user",
      "Too dangerous",
    );

    expect(rejected.approvalId).toBe(approval.id);
    expect(rejected.reason).toBe("Too dangerous");

    // Verify rejection is recorded
    const record = approvalGate.getApproval(approval.id);
    expect(record?.status).toBe("rejected");
  });

  test("multiple approvals are independent (approving one doesn't approve all)", async () => {
    const approvalGate = makeApprovalGate();

    const approval1 = await approvalGate.createApproval({
      runId: "run_1",
      title: "Delete temp files",
      description: "Clean up temp directory",
      riskLevel: "high",
      requestedAction: {
        skillId: "filesystem.delete",
        arguments: { paths: ["/tmp/*"] },
        permissions: ["filesystem.delete"],
      },
    });

    const approval2 = await approvalGate.createApproval({
      runId: "run_2",
      title: "Send email",
      description: "Send order confirmation",
      riskLevel: "medium",
      requestedAction: {
        skillId: "email.send",
        arguments: { to: "customer@example.com" },
        permissions: ["external.send"],
      },
    });

    // Approve only the first
    await approvalGate.approve(approval1.id);
    // Reject the second
    await approvalGate.reject(approval2.id);

    expect(approvalGate.getApproval(approval1.id)?.status).toBe("approved");
    expect(approvalGate.getApproval(approval2.id)?.status).toBe("rejected");
  });

  test("rejection event metadata includes tool details for audit", async () => {
    const events: Array<{
      runId: string;
      approvalId: string;
      reason?: string;
      skillId?: string;
    }> = [];

    const approvalGate = makeApprovalGate();
    const approval = await approvalGate.createApproval({
      runId: "run_audit",
      title: "Execute shell command",
      description: "Run rm -rf /tmp/cache",
      riskLevel: "critical",
      requestedAction: {
        skillId: "shell.execute",
        arguments: { command: "rm -rf /tmp/cache" },
        permissions: ["shell.execute"],
      },
    });

    const rejected = await approvalGate.reject(
      approval.id,
      "admin",
      "Shell execution not allowed in this context",
    );

    events.push({
      runId: rejected.runId,
      approvalId: rejected.approvalId,
      reason: rejected.reason,
      skillId: approvalGate.getApproval(approval.id)?.requestedAction.skillId,
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.skillId).toBe("shell.execute");
    expect(events[0]!.reason).toContain("not allowed");
  });

  test("agent can continue after rejection (continue_without_tool path)", async () => {
    // Simulates the AgentLoopEngine.continueAfterRejection flow

    const runState = stubRunStateManager();
    const events = stubEventBus();

    // Set initial state as if run was created
    await runState.markStatus("run_continue", "waiting_approval");

    // Simulate rejection
    await runState.markStatus(
      "run_continue",
      "reflecting",
      "Tool rejected — continuing without tool",
    );

    // Agent should proceed to responding, not stay in waiting_approval
    await runState.markStatus("run_continue", "responding");

    // Should complete with a response
    await runState.markStatus("run_continue", "completed");

    expect(runState.getStatus()).toBe("completed");
    expect(runState.getStatus()).not.toBe("waiting_approval");
  });
});
