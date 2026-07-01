import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { recoverAgentRuntimeRuns } from "./recovery.js";

describe("recoverAgentRuntimeRuns", () => {
  test("atomically interrupts every running page and keeps context in sync", async () => {
    const db = new InMemoryDatabaseContext();
    const createdAt = "2026-07-01T00:00:00.000Z";
    for (let index = 0; index < 205; index++) {
      const id = `run_recovery_${String(index).padStart(3, "0")}`;
      await db.runs.create({
        id,
        title: id,
        status: "running",
        mode: "agent",
        conversationId: `conv_${index}`,
        createdAt,
        updatedAt: new Date(Date.parse(createdAt) + index).toISOString(),
        input: { message: "resume me", client: { source: "api" } },
        context: {
          agentStatus: "running",
          statusHistory: [{
            previousStatus: "created",
            nextStatus: "running",
            actor: "system",
            createdAt,
          }],
        },
      });
    }

    const result = await recoverAgentRuntimeRuns(db);
    const first = await db.runs.findById("run_recovery_000");

    expect(result.interruptedRuns).toHaveLength(205);
    expect(result.failedRuns).toEqual([]);
    expect(first).toEqual(expect.objectContaining({
      status: "interrupted",
      error: expect.objectContaining({ code: "AGENT_RUN_INTERRUPTED" }),
      context: expect.objectContaining({
        agentStatus: "interrupted",
        statusHistory: expect.arrayContaining([
          expect.objectContaining({
            previousStatus: "running",
            nextStatus: "interrupted",
          }),
        ]),
      }),
    }));
    await expect(db.events.listByRunId("run_recovery_000")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent.run.interrupted" }),
      ]),
    );
  });

  test("fails orphaned created and waiting states instead of leaving them active", async () => {
    const db = new InMemoryDatabaseContext();
    const base = {
      title: "orphan",
      mode: "agent" as const,
      conversationId: "conv_orphan",
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:01.000Z",
      input: { message: "resume me" },
      context: {},
    };
    await db.runs.create({ ...base, id: "run_created", status: "created" });
    await db.runs.create({
      ...base,
      id: "run_waiting_approval",
      status: "waiting_approval",
    });
    await db.runs.create({
      ...base,
      id: "run_waiting_user",
      status: "waiting_user",
    });

    const result = await recoverAgentRuntimeRuns(db);

    expect(result.failedRuns).toEqual(expect.arrayContaining([
      "run_created",
      "run_waiting_approval",
      "run_waiting_user",
    ]));
    await expect(db.runs.findById("run_created")).resolves.toMatchObject({
      status: "failed",
      error: { code: "AGENT_RECOVERY_NOT_STARTED" },
    });
    await expect(db.runs.findById("run_waiting_approval")).resolves.toMatchObject({
      status: "failed",
      error: { code: "AGENT_RECOVERY_APPROVAL_MISSING" },
    });
    await expect(db.runs.findById("run_waiting_user")).resolves.toMatchObject({
      status: "failed",
      error: { code: "AGENT_RECOVERY_CHECKPOINT_MISSING" },
    });
  });
});
