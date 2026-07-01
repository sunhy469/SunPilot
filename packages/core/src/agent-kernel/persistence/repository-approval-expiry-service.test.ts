import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { RepositoryApprovalExpiryService } from "./repository-approval-expiry-service.js";

describe("RepositoryApprovalExpiryService", () => {
  test("expires every stale approval across repository page limits", async () => {
    const db = new InMemoryDatabaseContext();
    const now = "2026-07-01T12:00:00.000Z";
    for (let index = 0; index < 205; index++) {
      await db.approvals.create({
        id: `approval_stale_${index}`,
        runId: `missing_run_${index}`,
        status: "pending",
        risk: "medium",
        title: "stale",
        requestedAction: {},
        createdAt: "2026-07-01T10:00:00.000Z",
        expiresAt: "2026-07-01T11:00:00.000Z",
      });
    }
    await db.approvals.create({
      id: "approval_fresh",
      runId: "missing_run_fresh",
      status: "pending",
      risk: "medium",
      title: "fresh",
      requestedAction: {},
      createdAt: now,
      expiresAt: "2026-07-01T13:00:00.000Z",
    });

    const results = await new RepositoryApprovalExpiryService(db).expireStale(now);

    expect(results).toHaveLength(205);
    await expect(db.approvals.findById("approval_stale_204")).resolves.toEqual(
      expect.objectContaining({ status: "expired" }),
    );
    await expect(db.approvals.findById("approval_fresh")).resolves.toEqual(
      expect.objectContaining({ status: "pending" }),
    );
  });

  test("rolls back the approval decision when lifecycle persistence fails", async () => {
    const db = new InMemoryDatabaseContext();
    await db.approvals.create({
      id: "approval_atomic",
      runId: "missing_run",
      status: "pending",
      risk: "medium",
      title: "atomic",
      requestedAction: {},
      createdAt: "2026-07-01T10:00:00.000Z",
      expiresAt: "2026-07-01T11:00:00.000Z",
    });
    const originalCreate = db.audit.create;
    db.audit.create = async () => {
      throw new Error("audit unavailable");
    };

    await expect(
      new RepositoryApprovalExpiryService(db).expireStale(
        "2026-07-01T12:00:00.000Z",
      ),
    ).rejects.toThrow("audit unavailable");
    await expect(db.approvals.findById("approval_atomic")).resolves.toEqual(
      expect.objectContaining({ status: "pending" }),
    );
    db.audit.create = originalCreate;
  });
});
