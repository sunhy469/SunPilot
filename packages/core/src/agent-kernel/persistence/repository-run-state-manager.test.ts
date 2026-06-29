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
