import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { RepositoryApprovalGate } from "./repository-approval-gate.js";

describe("RepositoryApprovalGate", () => {
  test("does not consume a legacy approval that cannot resume", async () => {
    const db = new InMemoryDatabaseContext();
    await db.approvals.create({
      id: "approval_invalid",
      runId: "run_invalid",
      status: "pending",
      risk: "high",
      title: "Invalid legacy approval",
      requestedAction: { malformed: true },
      createdAt: new Date().toISOString(),
    });
    const gate = new RepositoryApprovalGate(db);

    await expect(gate.approve("approval_invalid", "tester")).rejects.toMatchObject({
      code: "AGENT_APPROVAL_NOT_RESUMABLE",
    });
    await expect(db.approvals.findById("approval_invalid")).resolves.toEqual(
      expect.objectContaining({ status: "pending" }),
    );
  });
});
