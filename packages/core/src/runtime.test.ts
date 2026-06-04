import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getSunPilotPaths, SunPilotDatabase } from "@sunpilot/storage";
import { WorkflowRegistry, type BusinessWorkflow } from "@sunpilot/workflow";
import type { ToolProvider } from "./providers.js";
import { SunPilotRuntime } from "./runtime.js";

const highRiskWorkflow: BusinessWorkflow = {
  id: "test.high-risk",
  title: "High Risk Test",
  version: "0.1.0",
  description: "Plans a high-risk capability without an explicit approval step.",
  async match() {
    return { score: 1, reason: "test" };
  },
  async plan() {
    return {
      runTitle: "High risk run",
      steps: [{ id: "danger", name: "Danger", type: "skill", providerId: "test.provider", capability: "danger.execute", input: { value: 1 }, risk: "high" }]
    };
  }
};

const provider: ToolProvider = {
  id: "test",
  type: "skill",
  async listCapabilities() {
    return [{ providerId: "test.provider", providerType: "skill", capabilityName: "danger.execute", title: "Danger", description: "Test danger", inputSchema: {}, outputSchema: {}, risk: "high", permissions: {} }];
  },
  async execute(request) {
    return { output: request.input };
  }
};

let home: string;
let db: SunPilotDatabase;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sunpilot-runtime-test-"));
  db = new SunPilotDatabase(getSunPilotPaths(home));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("SunPilotRuntime approval policy", () => {
  test("automatically gates a high-risk capability and resumes it after approval", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(highRiskWorkflow);
    const runtime = new SunPilotRuntime(db, workflows, [provider]);

    const waiting = await runtime.createRun({}, highRiskWorkflow.id, "auto");
    expect(waiting.status).toBe("waiting_approval");
    expect(db.listSteps(waiting.id)).toEqual([expect.objectContaining({ type: "skill", status: "waiting_approval" })]);
    const [approval] = db.listApprovals();
    expect(approval).toMatchObject({ status: "pending", risk: "high", requestedAction: { skillId: "test.provider", capability: "danger.execute" } });

    await runtime.approve(approval!.id, { reason: "test" });
    expect(db.getRun(waiting.id)).toMatchObject({ status: "completed" });
    expect(db.listSteps(waiting.id)).toEqual([expect.objectContaining({ type: "skill", status: "completed", output: { value: 1 } })]);
  });

  test("does not allow an approval to be decided more than once", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(highRiskWorkflow);
    const runtime = new SunPilotRuntime(db, workflows, [provider]);

    const waiting = await runtime.createRun({}, highRiskWorkflow.id, "auto");
    const [approval] = db.listApprovals();
    await runtime.approve(approval!.id, { reason: "test" });

    expect(() => runtime.reject(approval!.id, { reason: "late reject" })).toThrow("Approval is already approved");
    expect(db.getRun(waiting.id)).toMatchObject({ status: "completed" });
    expect(db.listSteps(waiting.id)).toEqual([expect.objectContaining({ type: "skill", status: "completed" })]);
  });

  test("requires approval for low-risk capabilities that declare privileged permissions", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(highRiskWorkflow);
    let executed = false;
    const permissionedProvider: ToolProvider = {
      ...provider,
      async listCapabilities() {
        return [
          {
            providerId: "test.provider",
            providerType: "skill",
            capabilityName: "danger.execute",
            title: "File Writer",
            description: "Declares filesystem write permission.",
            inputSchema: {},
            outputSchema: {},
            risk: "low",
            permissions: { filesystem: { write: ["/tmp"] } }
          }
        ];
      },
      async execute(request) {
        executed = true;
        return provider.execute(request);
      }
    };
    const runtime = new SunPilotRuntime(db, workflows, [permissionedProvider]);

    const waiting = await runtime.createRun({}, highRiskWorkflow.id, "auto");

    expect(waiting.status).toBe("waiting_approval");
    expect(executed).toBe(false);
    expect(db.listApprovals()).toEqual([
      expect.objectContaining({
        status: "pending",
        requestedAction: expect.objectContaining({ skillId: "test.provider", capability: "danger.execute" })
      })
    ]);
  });

  test("dry run plans steps without requesting approval or executing providers", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(highRiskWorkflow);
    let executed = false;
    const runtime = new SunPilotRuntime(db, workflows, [
      {
        ...provider,
        async execute(request) {
          executed = true;
          return provider.execute(request);
        }
      }
    ]);

    const run = await runtime.createRun({}, highRiskWorkflow.id, "dry_run");

    expect(run.status).toBe("completed");
    expect(executed).toBe(false);
    expect(db.listSteps(run.id)).toEqual([expect.objectContaining({ status: "skipped", output: { dryRun: true } })]);
    expect(db.listApprovals()).toEqual([]);
    expect(db.listJobs(run.id)).toEqual([expect.objectContaining({ status: "completed", payload: { workflowId: highRiskWorkflow.id, mode: "dry_run" } })]);
    expect(db.listEvents(run.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "workflow.planned" }), expect.objectContaining({ type: "run.completed", payload: { dryRun: true } })]));
  });

  test("preserves interrupted state when an active provider rejects after cancellation", async () => {
    let rejectExecution: ((error: Error) => void) | undefined;
    const interruptible: ToolProvider = {
      ...provider,
      async listCapabilities() {
        return (await provider.listCapabilities()).map((capability) => ({ ...capability, risk: "low" as const }));
      },
      execute() {
        return new Promise((_resolve, reject) => {
          rejectExecution = reject;
        });
      },
      interrupt() {
        rejectExecution?.(new Error("interrupted"));
      }
    };
    const workflows = new WorkflowRegistry();
    workflows.register(highRiskWorkflow);
    const runtime = new SunPilotRuntime(db, workflows, [interruptible]);

    const execution = runtime.createRun({}, highRiskWorkflow.id, "auto");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const [run] = db.listRuns();
    runtime.interrupt(run!.id);
    await execution;

    expect(db.getRun(run!.id)).toMatchObject({ status: "interrupted" });
    expect(db.listSteps(run!.id)).toEqual([expect.objectContaining({ status: "interrupted" })]);
    expect(db.listEvents(run!.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "step.interrupted" }), expect.objectContaining({ type: "run.interrupted" })]));
  });

  test("cancels a waiting run without executing pending skill steps", async () => {
    const workflows = new WorkflowRegistry();
    workflows.register(highRiskWorkflow);
    let executed = false;
    const runtime = new SunPilotRuntime(db, workflows, [
      {
        ...provider,
        async execute(request) {
          executed = true;
          return provider.execute(request);
        }
      }
    ]);

    const waiting = await runtime.createRun({}, highRiskWorkflow.id, "auto");
    const canceled = runtime.cancel(waiting.id);

    expect(canceled.status).toBe("canceled");
    expect(executed).toBe(false);
    expect(db.listSteps(waiting.id)).toEqual([expect.objectContaining({ status: "canceled", error: { reason: "run canceled" } })]);
    expect(db.listEvents(waiting.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "run.canceled" })]));
    expect(db.listAuditLogs()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "run.cancel", target: waiting.id })]));
  });

  test("rejects interrupt and cancel for unknown runs", () => {
    const workflows = new WorkflowRegistry();
    workflows.register(highRiskWorkflow);
    const runtime = new SunPilotRuntime(db, workflows, [provider]);

    expect(() => runtime.interrupt("run_missing")).toThrow("Unknown run: run_missing");
    expect(() => runtime.cancel("run_missing")).toThrow("Unknown run: run_missing");
  });
});
