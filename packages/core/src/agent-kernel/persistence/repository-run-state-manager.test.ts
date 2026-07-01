import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { RepositoryAgentEventSink } from "./agent-event-sink.js";
import { RepositoryRunStateManager } from "./repository-run-state-manager.js";
import type { AgentEvent } from "../agent-event-bus.js";
import type { AgentLoopInput } from "../loop-types.js";

const loopInput: AgentLoopInput = {
  runId: "run_persisted",
  conversationId: "conv_persisted",
  userMessageId: "msg_user",
  message: "Persist this run",
  mode: "agent",
  client: { source: "web", connectionId: "ws_1" },
};

describe("RepositoryRunStateManager", () => {
  test("persists and exposes the complete versioned retry input snapshot", async () => {
    const db = new InMemoryDatabaseContext();
    const manager = new RepositoryRunStateManager(db);
    const input: AgentLoopInput = {
      ...loopInput,
      permissionMode: "ask",
      modelId: "seed",
      attachments: [
        { id: "file_1", name: "brief.pdf", type: "application/pdf" },
      ],
    };

    const state = await manager.createRun(input);

    expect(state.input).toEqual({
      version: 1,
      message: input.message,
      attachments: input.attachments,
      client: input.client,
      permissionMode: "ask",
      modelId: "seed",
      mode: "agent",
      userMessageId: input.userMessageId,
    });
  });

  test("does not acquire execution after a concurrent cancellation", async () => {
    const db = new InMemoryDatabaseContext();
    const manager = new RepositoryRunStateManager(db);
    await manager.createRun({ ...loopInput, runId: "run_cancel_before_start" });
    await manager.markCancelled("run_cancel_before_start");

    const result = await manager.acquireExecution("run_cancel_before_start", [
      "created",
    ]);

    expect(result.acquired).toBe(false);
    expect(result.state.status).toBe("cancelled");
  });

  test("persists agent run state transitions to storage", async () => {
    const db = new InMemoryDatabaseContext();
    const manager = new RepositoryRunStateManager(db);

    await manager.createRun(loopInput);
    const state = await manager.markStatus(loopInput.runId, "running");

    expect(state).toEqual(
      expect.objectContaining({
        runId: loopInput.runId,
        conversationId: loopInput.conversationId,
        status: "running",
        goal: loopInput.message,
      }),
    );

    await expect(db.runs.findById(loopInput.runId)).resolves.toEqual(
      expect.objectContaining({
        id: loopInput.runId,
        conversationId: loopInput.conversationId,
        mode: "agent",
        status: "running",
        goal: loopInput.message,
        context: expect.objectContaining({
          agentStatus: "running",
          statusHistory: expect.arrayContaining([
            expect.objectContaining({ nextStatus: "created" }),
            expect.objectContaining({ nextStatus: "running" }),
          ]),
        }),
      }),
    );
    await expect(db.runStatusHistory.listByRunId(loopInput.runId)).resolves.toEqual([
      expect.objectContaining({ nextStatus: "created" }),
      expect.objectContaining({ previousStatus: "created", nextStatus: "running" }),
    ]);
  });

  test("persists the dedicated cancellation timestamp", async () => {
    const db = new InMemoryDatabaseContext();
    const manager = new RepositoryRunStateManager(db);
    await manager.createRun({ ...loopInput, runId: "run_cancelled" });
    await manager.markStatus("run_cancelled", "running");

    const state = await manager.markCancelled("run_cancelled", "user requested");
    const stored = await db.runs.findById("run_cancelled");

    expect(state.status).toBe("cancelled");
    expect(state.cancelledAt).toBeTruthy();
    expect(stored?.cancelledAt).toBeTruthy();
  });

  test("allows only one competing terminal transition to commit", async () => {
    const db = new InMemoryDatabaseContext();
    // Exercise the repository compare-and-set directly. The test database's
    // snapshot transaction helper is intentionally single-transaction only
    // and cannot model PostgreSQL's concurrent transaction isolation.
    Object.defineProperty(db, "transaction", { value: undefined });
    const manager = new RepositoryRunStateManager(db);
    await manager.createRun({ ...loopInput, runId: "run_race" });
    await manager.markStatus("run_race", "running");

    const results = await Promise.allSettled([
      manager.markStatus("run_race", "completed", "finished"),
      manager.markCancelled("run_race", "cancelled concurrently"),
    ]);
    const state = await manager.getRun("run_race");
    const history = await db.runStatusHistory.listByRunId("run_race");

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(["completed", "cancelled"]).toContain(state?.status);
    expect(history.filter((entry) =>
      entry.nextStatus === "completed" || entry.nextStatus === "cancelled"
    )).toHaveLength(1);
  });

  test("fails loudly instead of dropping a checkpoint for an unknown run", async () => {
    const manager = new RepositoryRunStateManager(new InMemoryDatabaseContext());
    await expect(manager.saveTaskState("missing", {
      goal: "checkpoint",
      completedSteps: [],
      pendingSteps: [],
      gatheredFacts: {},
      openQuestions: [],
      iteration: 0,
    })).rejects.toMatchObject({ code: "AGENT_RUN_NOT_FOUND" });
  });

  test("persists agent events with conversation sequence metadata", async () => {
    const db = new InMemoryDatabaseContext();
    const sink = new RepositoryAgentEventSink(db);
    const event: AgentEvent = {
      id: "evt_agent",
      type: "agent.run.created",
      runId: loopInput.runId,
      conversationId: loopInput.conversationId,
      payload: { runId: loopInput.runId, conversationId: loopInput.conversationId, mode: "agent" },
      createdAt: "2026-06-06T00:00:00.000Z",
    };

    await sink.persist(event);

    await expect(db.events.listByRunId(loopInput.runId)).resolves.toEqual([
      expect.objectContaining({
        id: event.id,
        runId: loopInput.runId,
        conversationId: loopInput.conversationId,
        sequence: 1,
        type: "agent.run.created",
      }),
    ]);
    await expect(
      db.events.listByConversationId?.(loopInput.conversationId, 0),
    ).resolves.toEqual([expect.objectContaining({ id: event.id })]);
  });
});
