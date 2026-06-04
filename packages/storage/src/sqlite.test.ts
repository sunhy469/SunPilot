import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getSunPilotPaths } from "./paths.js";
import { writeArtifact } from "./artifacts.js";
import { SunPilotDatabase } from "./sqlite.js";

let home: string;
let db: SunPilotDatabase;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sunpilot-storage-test-"));
  db = new SunPilotDatabase(getSunPilotPaths(home));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("SunPilotDatabase job queue", () => {
  test("initializes first-phase metadata tables and log files", () => {
    expect(db.tableNames()).toEqual(
      expect.arrayContaining([
        "settings",
        "skill_permissions",
        "memory_metadata",
        "local_auth_sessions",
        "runs",
        "steps",
        "events",
        "installed_skills",
        "workflows",
        "approvals",
        "artifacts",
        "audit_logs",
        "job_queue"
      ])
    );
    expect(existsSync(join(home, "logs", "daemon.log"))).toBe(true);
    expect(existsSync(join(home, "logs", "audit.log"))).toBe(true);
    expect(existsSync(join(home, "logs", "skill.log"))).toBe(true);

    db.audit({ actor: "test", action: "audit.write", target: "storage", payload: { ok: true } });
    expect(readFileSync(join(home, "logs", "audit.log"), "utf8")).toContain("\"action\":\"audit.write\"");
  });

  test("redacts secrets and local paths from audit storage and logs", () => {
    db.audit({
      actor: "test",
      action: "secret.read",
      target: join(home, "runtime", "auth-token"),
      payload: {
        authorization: "Bearer top-secret",
        nested: { apiKey: "sk-sensitive-key-value", note: `read ${join(home, "skills")}`, env: "OPENAI_API_KEY" }
      }
    });

    const [record] = db.listAuditLogs();
    expect(record).toMatchObject({
      target: "[LOCAL_PATH]/runtime/auth-token",
      payload: {
        authorization: "[REDACTED]",
        nested: { apiKey: "[REDACTED]", note: "read [LOCAL_PATH]/skills", env: "[REDACTED_NAME]" }
      }
    });
    const log = readFileSync(join(home, "logs", "audit.log"), "utf8");
    expect(log).not.toContain(home);
    expect(log).not.toContain("top-secret");
    expect(log).not.toContain("sensitive-key-value");
    expect(log).not.toContain("OPENAI_API_KEY");
  });

  test("expires timed out pending jobs and records run failure event", () => {
    const now = "2026-06-04T00:00:00.000Z";
    db.insertRun({
      id: "run_timeout",
      title: "Timeout run",
      status: "running",
      mode: "approval_required",
      workflowId: "fixture.echo",
      createdAt: now,
      updatedAt: now,
      input: { text: "timeout" },
      context: {}
    });
    db.insertJob({
      id: "job_timeout",
      runId: "run_timeout",
      status: "running",
      timeoutAt: "2026-06-03T23:59:59.000Z",
      payload: { workflowId: "fixture.echo" }
    });

    expect(db.expireTimedOutJobs(now)).toEqual(["run_timeout"]);
    expect(db.getRun("run_timeout")).toMatchObject({ status: "failed", completedAt: now });
    expect(db.listJobs("run_timeout")).toEqual([expect.objectContaining({ status: "failed", timeoutAt: "2026-06-03T23:59:59.000Z" })]);
    expect(db.listEvents("run_timeout")).toEqual([expect.objectContaining({ type: "run.failed", payload: { reason: "job timed out" } })]);
  });

  test("keeps artifact writes inside their run directory", () => {
    const paths = getSunPilotPaths(home);
    const artifact = writeArtifact(paths, {
      runId: "run_safe",
      type: "json",
      name: "nested/result.json",
      content: "{}"
    });
    expect(artifact.path).toBe(join(home, "artifacts", "runs", "run_safe", "nested", "result.json"));
    expect(() =>
      writeArtifact(paths, {
        runId: "run_safe",
        type: "text",
        name: "../../escaped.txt",
        content: "denied"
      })
    ).toThrow("must stay within its run directory");
    expect(existsSync(join(home, "artifacts", "escaped.txt"))).toBe(false);
  });

  test("records step start and completion timestamps only for matching states", () => {
    const now = "2026-06-04T00:00:00.000Z";
    db.insertRun({ id: "run_step", title: "Step timestamps", status: "running", mode: "auto", createdAt: now, updatedAt: now, input: {}, context: {} });
    db.insertStep({ id: "step_1", runId: "run_step", type: "skill", name: "Step", status: "pending", input: {} });

    db.updateStep("step_1", "waiting_approval");
    expect(db.listSteps("run_step")[0]).toMatchObject({ status: "waiting_approval", startedAt: undefined, completedAt: undefined });
    db.updateStep("step_1", "running");
    expect(db.listSteps("run_step")[0]).toMatchObject({ status: "running", completedAt: undefined });
    expect(db.listSteps("run_step")[0]!.startedAt).toBeDefined();
    db.updateStep("step_1", "completed", { ok: true });
    expect(db.listSteps("run_step")[0]).toMatchObject({ status: "completed", output: { ok: true } });
    expect(db.listSteps("run_step")[0]!.completedAt).toBeDefined();
  });
});
