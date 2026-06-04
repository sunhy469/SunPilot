import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import { createDaemon } from "@sunpilot/daemon";

type Daemon = Awaited<ReturnType<typeof createDaemon>>;

let daemon: Daemon | undefined;
let home: string;

function auth() {
  return { authorization: `Bearer ${daemon!.token}` };
}

async function createRun(text: string) {
  const response = await daemon!.app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: auth(),
    payload: { input: { text }, workflowId: "fixture.echo" }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as { id: string; status: string };
}

async function approvePending() {
  const approvalList = await daemon!.app.inject({ method: "GET", url: "/v1/approvals", headers: auth() });
  expect(approvalList.statusCode).toBe(200);
  const approval = (approvalList.json() as Array<{ id: string; status: string }>).find((item) => item.status === "pending");
  expect(approval).toBeDefined();
  return daemon!.app.inject({
    method: "POST",
    url: `/v1/approvals/${approval!.id}/approve`,
    headers: auth(),
    payload: { reason: "test approval" }
  });
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "sunpilot-test-"));
  process.env.SUNPILOT_HOME = home;
  process.env.SUNPILOT_LOG_LEVEL = "silent";
  daemon = await createDaemon({ port: 0 });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  delete process.env.SUNPILOT_HOME;
  rmSync(home, { recursive: true, force: true });
  delete process.env.SUNPILOT_ALLOWED_ORIGINS;
});

describe("SunPilot daemon first-phase flow", () => {
  test("protects writes with local token and reports readiness", async () => {
    const health = await daemon!.app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, daemon: "alive" });

    const ready = await daemon!.app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ok: true,
      database: true,
      config: {
        server: { host: "127.0.0.1", port: 3737 },
        security: { requireLocalToken: true, allowLan: false }
      },
      skills: 3,
      workflows: 4,
      storage: {
        duckDb: { enabled: false, path: join(home, "analytics") },
        lanceDb: { enabled: false, path: join(home, "vectors", "lance") }
      }
    });
    expect(existsSync(join(home, "analytics"))).toBe(true);
    expect(existsSync(join(home, "vectors", "lance"))).toBe(true);

    const denied = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: { input: { text: "no token" }, workflowId: "fixture.echo" }
    });
    expect(denied.statusCode).toBe(401);

    const deniedRead = await daemon!.app.inject({ method: "GET", url: "/v1/runs" });
    expect(deniedRead.statusCode).toBe(401);

    const deniedQueryTokenRead = await daemon!.app.inject({ method: "GET", url: `/v1/runs?token=${daemon!.token}` });
    expect(deniedQueryTokenRead.statusCode).toBe(401);

    const rejectedOrigin = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth(), origin: "https://example.com" },
      payload: { input: { text: "bad origin" }, workflowId: "fixture.echo" }
    });
    expect(rejectedOrigin.statusCode).toBe(403);

    const localOrigin = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth(), origin: "http://127.0.0.1:3737" },
      payload: { input: { text: "local origin" }, workflowId: "fixture.echo" }
    });
    expect(localOrigin.statusCode).toBe(200);
  });

  test("allows the default tradeagent reverse-proxy origins", async () => {
    const allowedOrigin = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth(), origin: "https://tradeagent.asia" },
      payload: { input: { text: "domain origin" }, workflowId: "fixture.echo" }
    });
    expect(allowedOrigin.statusCode).toBe(200);

    const allowedWwwOrigin = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth(), origin: "https://www.tradeagent.asia" },
      payload: { input: { text: "www domain origin" }, workflowId: "fixture.echo" }
    });
    expect(allowedWwwOrigin.statusCode).toBe(200);

    const rejectedOrigin = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: { ...auth(), origin: "https://evil.example" },
      payload: { input: { text: "bad domain origin" }, workflowId: "fixture.echo" }
    });
    expect(rejectedOrigin.statusCode).toBe(403);
  });

  test("returns client errors for invalid API requests", async () => {
    const invalidWorkflow = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: auth(),
      payload: { input: { text: "bad workflow" }, workflowId: "missing.workflow" }
    });
    expect(invalidWorkflow.statusCode).toBe(404);
    expect(invalidWorkflow.json()).toMatchObject({ error: "not_found", message: "Unknown workflow: missing.workflow" });

    const invalidMode = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: auth(),
      payload: { input: {}, workflowId: "fixture.echo", mode: "bogus" }
    });
    expect(invalidMode.statusCode).toBe(400);
    expect(invalidMode.json()).toMatchObject({ error: "bad_request" });
  });

  test("exposes capability index through provider boundary", async () => {
    const capabilities = await daemon!.app.inject({ method: "GET", url: "/v1/capabilities", headers: auth() });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "fixture.echo-skill", providerType: "skill", capabilityName: "echo.message", risk: "low" }),
        expect.objectContaining({ providerId: "fixture.shell-skill", providerType: "skill", capabilityName: "shell.noop", risk: "critical" }),
        expect.objectContaining({ providerId: "fixture.file-skill", providerType: "skill", capabilityName: "files.writeOutside", risk: "high" })
      ])
    );
    expect(capabilities.json()).not.toEqual(expect.arrayContaining([expect.objectContaining({ providerType: "mcp" })]));
  });

  test("lists config, workflow, skill, approval, artifact, memory, and job API surfaces", async () => {
    const config = await daemon!.app.inject({ method: "GET", url: "/v1/config", headers: auth() });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ storage: { home }, security: { allowLan: false } });

    const workflows = await daemon!.app.inject({ method: "GET", url: "/v1/workflows", headers: auth() });
    expect(workflows.statusCode).toBe(200);
    expect(workflows.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fixture.echo" })]));

    const workflow = await daemon!.app.inject({ method: "GET", url: "/v1/workflows/fixture.echo", headers: auth() });
    expect(workflow.statusCode).toBe(200);
    expect(workflow.json()).toMatchObject({ id: "fixture.echo", enabled: true });

    const skills = await daemon!.app.inject({ method: "GET", url: "/v1/skills", headers: auth() });
    expect(skills.statusCode).toBe(200);
    expect(skills.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "fixture.echo-skill" })]));

    const skill = await daemon!.app.inject({ method: "GET", url: "/v1/skills/fixture.echo-skill", headers: auth() });
    expect(skill.statusCode).toBe(200);
    expect(skill.json()).toMatchObject({ id: "fixture.echo-skill", enabled: true });

    const approvals = await daemon!.app.inject({ method: "GET", url: "/v1/approvals", headers: auth() });
    expect(approvals.statusCode).toBe(200);

    const artifacts = await daemon!.app.inject({ method: "GET", url: "/v1/artifacts", headers: auth() });
    expect(artifacts.statusCode).toBe(200);

    const memory = await daemon!.app.inject({ method: "GET", url: "/v1/memory", headers: auth() });
    expect(memory.statusCode).toBe(200);

    const jobs = await daemon!.app.inject({ method: "GET", url: "/v1/jobs", headers: auth() });
    expect(jobs.statusCode).toBe(200);
  });

  test("updates managed config through daemon API with local safety constraints and audit log", async () => {
    const denied = await daemon!.app.inject({ method: "PATCH", url: "/v1/config", payload: { server: { port: 4111 } } });
    expect(denied.statusCode).toBe(401);

    const updated = await daemon!.app.inject({
      method: "PATCH",
      url: "/v1/config",
      headers: auth(),
      payload: {
        server: { host: "0.0.0.0", port: 4111 },
        security: { requireLocalToken: false, allowLan: true },
        skills: { directories: [join(home, "custom-skills")], autoReload: false }
      }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      server: { host: "127.0.0.1", port: 4111 },
      security: { requireLocalToken: false, allowLan: false },
      skills: { directories: [join(home, "custom-skills")], autoReload: false },
      storage: { home }
    });
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8"))).toMatchObject(updated.json());

    const audit = await daemon!.app.inject({ method: "GET", url: "/v1/audit-logs", headers: auth() });
    expect(audit.json()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "config.update", target: "config.json" })]));
  });

  test("creates a run, waits for approval, executes skill, records events and artifact", async () => {
    const run = await createRun("run fixture echo workflow");
    expect(run.status).toBe("waiting_approval");

    const approval = await approvePending();
    expect(approval.statusCode).toBe(200);
    expect(approval.json()).toMatchObject({ status: "approved" });
    const approvalId = approval.json().id as string;

    const detail = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(detail.statusCode).toBe(200);
    const body = detail.json() as {
      status: string;
      steps: Array<{ type: string; status: string }>;
      events: Array<{ type: string }>;
      artifacts: Array<{ id: string; name: string }>;
      memory: Array<{ key: string; value: { message?: string } }>;
    };
    expect(body.status).toBe("completed");
    expect(body.steps).toEqual(expect.arrayContaining([expect.objectContaining({ type: "approval", status: "completed" }), expect.objectContaining({ type: "skill", status: "completed" })]));
    expect(body.events.map((event) => event.type)).toEqual(expect.arrayContaining(["approval.requested", "approval.approved", "skill.execution.completed", "artifact.created", "memory.written", "run.completed"]));
    expect(body.artifacts).toEqual([expect.objectContaining({ name: "echo-result.json" })]);
    expect(body.memory).toEqual([
      expect.objectContaining({
        key: "fixture.echo.last_message",
        value: expect.objectContaining({ message: "run fixture echo workflow" })
      })
    ]);

    const runMemory = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}/memory?key=fixture.echo.last_message`, headers: auth() });
    expect(runMemory.statusCode).toBe(200);
    expect(runMemory.json()).toEqual([expect.objectContaining({ runId: run.id, key: "fixture.echo.last_message" })]);

    const memory = await daemon!.app.inject({ method: "GET", url: `/v1/memory?runId=${run.id}`, headers: auth() });
    expect(memory.statusCode).toBe(200);
    expect(memory.json()).toEqual([expect.objectContaining({ runId: run.id, key: "fixture.echo.last_message" })]);

    const artifact = await daemon!.app.inject({
      method: "GET",
      url: `/v1/artifacts/${body.artifacts[0]!.id}/content?token=${daemon!.token}`
    });
    expect(artifact.statusCode).toBe(200);
    expect(artifact.body).toContain("run fixture echo workflow");

    const deniedArtifact = await daemon!.app.inject({
      method: "GET",
      url: `/v1/artifacts/${body.artifacts[0]!.id}/content`
    });
    expect(deniedArtifact.statusCode).toBe(401);

    const artifactMeta = await daemon!.app.inject({ method: "GET", url: `/v1/artifacts/${body.artifacts[0]!.id}`, headers: auth() });
    unlinkSync(artifactMeta.json().path);
    const missingArtifact = await daemon!.app.inject({
      method: "GET",
      url: `/v1/artifacts/${body.artifacts[0]!.id}/content?token=${daemon!.token}`
    });
    expect(missingArtifact.statusCode).toBe(404);
    expect(missingArtifact.json()).toEqual({ error: "artifact_content_missing" });

    const audit = await daemon!.app.inject({ method: "GET", url: "/v1/audit-logs", headers: auth() });
    expect(audit.statusCode).toBe(200);
    expect((audit.json() as Array<{ action: string }>).map((item) => item.action)).toEqual(expect.arrayContaining(["approval.request", "approval.approve", "skill.execute"]));

    const jobs = await daemon!.app.inject({ method: "GET", url: "/v1/jobs", headers: auth() });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json()).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, status: "completed" })]));

    const lateReject = await daemon!.app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/reject`,
      headers: auth(),
      payload: { reason: "too late" }
    });
    expect(lateReject.statusCode).toBe(409);
    const stillCompleted = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(stillCompleted.json()).toMatchObject({ status: "completed" });
  });

  test("dry-run creates a plan without approval, skill execution, artifacts, or memory", async () => {
    const response = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: auth(),
      payload: { input: { text: "dry run fixture echo workflow" }, workflowId: "fixture.echo", mode: "dry_run" }
    });
    expect(response.statusCode).toBe(200);
    const run = response.json() as { id: string; status: string; mode: string };
    expect(run).toMatchObject({ status: "completed", mode: "dry_run" });

    const detail = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      status: "completed",
      artifacts: [],
      memory: []
    });
    expect((detail.json() as { steps: Array<{ status: string; output?: unknown }> }).steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "skipped", output: { dryRun: true } })])
    );
    expect((detail.json() as { events: Array<{ type: string; payload?: unknown }> }).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "workflow.planned" }), expect.objectContaining({ type: "run.completed", payload: { dryRun: true } })])
    );
    expect((detail.json() as { events: Array<{ type: string }> }).events.map((event) => event.type)).not.toEqual(expect.arrayContaining(["approval.requested", "skill.execution.started", "artifact.created", "memory.written"]));

    const approvals = await daemon!.app.inject({ method: "GET", url: "/v1/approvals", headers: auth() });
    expect((approvals.json() as Array<{ runId: string }>).some((approval) => approval.runId === run.id)).toBe(false);

    const jobs = await daemon!.app.inject({ method: "GET", url: "/v1/jobs", headers: auth() });
    expect(jobs.json()).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, status: "completed", payload: { workflowId: "fixture.echo", mode: "dry_run" } })]));
  });

  test("disables and enables skills, and disabled skill execution fails through daemon policy", async () => {
    const disabled = await daemon!.app.inject({ method: "POST", url: "/v1/skills/fixture.echo-skill/disable", headers: auth() });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ id: "fixture.echo-skill", enabled: false });

    const run = await createRun("disabled skill should fail");
    const approval = await approvePending();
    expect(approval.statusCode).toBe(500);

    const detail = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(detail.json()).toMatchObject({ status: "failed" });
    expect((detail.json() as { events: Array<{ type: string; payload?: { message?: string } }> }).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "skill.execution.failed", payload: expect.objectContaining({ message: expect.stringContaining("not installed or enabled") }) })])
    );
    const jobs = await daemon!.app.inject({ method: "GET", url: "/v1/jobs", headers: auth() });
    expect(jobs.json()).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, status: "failed" })]));

    const enabled = await daemon!.app.inject({ method: "POST", url: "/v1/skills/fixture.echo-skill/enable", headers: auth() });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ id: "fixture.echo-skill", enabled: true });
  });

  test("reloads skills installed under the local SunPilot skills directory", async () => {
    const skillRoot = join(home, "skills", "local.echo");
    mkdirSync(join(skillRoot, "dist"), { recursive: true });
    mkdirSync(join(skillRoot, "schemas"), { recursive: true });
    writeFileSync(join(skillRoot, "README.md"), "Local echo skill\n");
    writeFileSync(join(skillRoot, "dist", "index.js"), "export default {}\n");
    writeFileSync(join(skillRoot, "schemas", "input.json"), "{}\n");
    writeFileSync(join(skillRoot, "schemas", "output.json"), "{}\n");
    writeFileSync(
      join(skillRoot, "skill.json"),
      JSON.stringify({
        schemaVersion: "sunpilot.skill/v1",
        id: "local.echo",
        name: "Local Echo",
        version: "0.1.0",
        description: "Local skill reload fixture.",
        entry: "dist/index.js",
        readme: "README.md",
        runtime: { node: ">=22", module: "esm" },
        capabilities: [
          {
            name: "local.echo",
            title: "Local Echo",
            description: "Local echo capability.",
            inputSchema: "schemas/input.json",
            outputSchema: "schemas/output.json",
            risk: "low",
            permissions: []
          }
        ],
        permissions: {}
      })
    );

    const reloaded = await daemon!.app.inject({ method: "POST", url: "/v1/skills/reload", headers: auth() });
    expect(reloaded.statusCode).toBe(200);
    expect(reloaded.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "local.echo", readmeSummary: "Local echo skill\n" })]));

    const capabilities = await daemon!.app.inject({ method: "GET", url: "/v1/capabilities", headers: auth() });
    expect(capabilities.json()).toEqual(
      expect.arrayContaining([expect.objectContaining({ providerId: "local.echo", capabilityName: "local.echo", providerType: "skill" })])
    );
  });

  test("denies skill execution when manifest declares shell permission", async () => {
    const response = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: auth(),
      payload: { input: { text: "shell permission should fail" }, workflowId: "fixture.shell-permission" }
    });
    expect(response.statusCode).toBe(200);
    const run = response.json() as { id: string; status: string };
    expect(run.status).toBe("waiting_approval");

    const approval = await approvePending();
    expect(approval.statusCode).toBe(500);

    const detail = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(detail.json()).toMatchObject({ status: "failed" });
    expect((detail.json() as { events: Array<{ type: string; payload?: { message?: string } }> }).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "skill.execution.failed", payload: expect.objectContaining({ message: expect.stringContaining("shell access is not allowed") }) })])
    );
  });

  test("denies file writes not declared in skill manifest permissions", async () => {
    const deniedPath = "/tmp/sunpilot-denied.txt";
    rmSync(deniedPath, { force: true });
    const response = await daemon!.app.inject({
      method: "POST",
      url: "/v1/runs",
      headers: auth(),
      payload: { input: { text: "file permission should fail" }, workflowId: "fixture.file-permission" }
    });
    expect(response.statusCode).toBe(200);
    const run = response.json() as { id: string; status: string };
    expect(run.status).toBe("waiting_approval");

    const approval = await approvePending();
    expect(approval.statusCode).toBe(500);
    expect(existsSync(deniedPath)).toBe(false);

    const detail = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(detail.json()).toMatchObject({ status: "failed" });
    expect((detail.json() as { events: Array<{ type: string; payload?: { message?: string } }> }).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "skill.execution.failed", payload: expect.objectContaining({ message: expect.stringContaining("file write is not allowed") }) })])
    );
  });

  test("retries a run by creating a new run from the original input", async () => {
    const run = await createRun("retry source");
    const retry = await daemon!.app.inject({ method: "POST", url: `/v1/runs/${run.id}/retry`, headers: auth() });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: "waiting_approval", input: { text: "retry source" } });
    expect(retry.json().id).not.toBe(run.id);
  });

  test("cancels a waiting run through the Local API", async () => {
    const run = await createRun("cancel source");
    const canceled = await daemon!.app.inject({ method: "POST", url: `/v1/runs/${run.id}/cancel`, headers: auth() });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({ id: run.id, status: "canceled" });

    const detail = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(detail.json()).toMatchObject({ status: "canceled" });
    expect((detail.json() as { steps: Array<{ status: string }> }).steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "canceled" })])
    );
    expect((detail.json() as { events: Array<{ type: string }> }).events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "run.canceled" })])
    );

    const jobs = await daemon!.app.inject({ method: "GET", url: "/v1/jobs", headers: auth() });
    expect(jobs.json()).toEqual(expect.arrayContaining([expect.objectContaining({ runId: run.id, status: "canceled" })]));
  });

  test("recovers a waiting approval run across daemon restart and continues after approval", async () => {
    const run = await createRun("restart recovery");
    await daemon!.stop();
    daemon = await createDaemon({ port: 0 });

    const detail = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ status: "waiting_approval" });
    expect((detail.json() as { steps: Array<{ type: string; status: string }> }).steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "approval", status: "waiting_approval" })])
    );

    const approval = await approvePending();
    expect(approval.statusCode).toBe(200);

    const completed = await daemon!.app.inject({ method: "GET", url: `/v1/runs/${run.id}`, headers: auth() });
    expect(completed.json()).toMatchObject({ status: "completed" });
  });

  test("accepts WebSocket JSON-RPC run.create with local token", async () => {
    const port = 39200 + Math.floor(Math.random() * 1000);
    await daemon!.stop();
    daemon = await createDaemon({ port });
    await daemon.start();

    const audit = await daemon!.app.inject({ method: "GET", url: "/v1/audit-logs", headers: auth() });
    expect(audit.statusCode).toBe(200);
    expect(audit.json()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "daemon.start", target: `127.0.0.1:${port}` })]));

    const response = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${daemon!.token}`);
      ws.once("error", reject);
      ws.once("open", () => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "req_1",
            method: "run.create",
            params: { input: { text: "websocket fixture" }, workflowId: "fixture.echo" }
          })
        );
      });
      ws.once("message", (raw) => {
        ws.close();
        resolve(JSON.parse(String(raw)));
      });
    });

    expect(response).toMatchObject({ jsonrpc: "2.0", id: "req_1", result: { status: "waiting_approval", input: { text: "websocket fixture" } } });
  });

  test("subscribes to run events over WebSocket with history replay", async () => {
    const port = 39800 + Math.floor(Math.random() * 500);
    await daemon!.stop();
    daemon = await createDaemon({ port });
    await daemon.start();

    const messages = await new Promise<any[]>((resolve, reject) => {
      const received: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${daemon!.token}`);
      ws.once("error", reject);
      ws.once("open", () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: "subscribe_all", method: "run.subscribe", params: {} }));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: "create_run", method: "run.create", params: { input: { text: "event subscription" }, workflowId: "fixture.echo" } }));
      });
      ws.on("message", (raw) => {
        received.push(JSON.parse(String(raw)));
        if (received.some((message) => message.method === "run.event" && message.params?.event?.type === "approval.requested")) {
          ws.close();
          resolve(received);
        }
      });
    });

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "subscribe_all", result: { runId: "*", events: [] } }),
      expect.objectContaining({ method: "run.event", params: expect.objectContaining({ event: expect.objectContaining({ type: "approval.requested" }) }) })
    ]));

    const runId = messages.find((message) => message.id === "create_run")!.result.id as string;
    const history = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${daemon!.token}`);
      ws.once("error", reject);
      ws.once("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: "history", method: "run.subscribe", params: { runId } })));
      ws.once("message", (raw) => {
        ws.close();
        resolve(JSON.parse(String(raw)));
      });
    });
    expect(history.result.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "run.created" }), expect.objectContaining({ type: "approval.requested" })]));
  });

  test("returns a JSON-RPC error for malformed WebSocket messages and keeps the connection usable", async () => {
    const port = 40300 + Math.floor(Math.random() * 500);
    await daemon!.stop();
    daemon = await createDaemon({ port });
    await daemon.start();

    const responses = await new Promise<any[]>((resolve, reject) => {
      const received: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${daemon!.token}`);
      ws.once("error", reject);
      ws.once("open", () => ws.send("{"));
      ws.on("message", (raw) => {
        received.push(JSON.parse(String(raw)));
        if (received.length === 1) {
          ws.send(JSON.stringify({ jsonrpc: "2.0", id: "after_error", method: "run.subscribe", params: {} }));
        } else {
          ws.close();
          resolve(received);
        }
      });
    });

    expect(responses[0]).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
    expect(responses[1]).toMatchObject({ jsonrpc: "2.0", id: "after_error", result: { runId: "*", events: [] } });
  });

  test("maps WebSocket JSON-RPC client errors without collapsing them into internal errors", async () => {
    const port = 40800 + Math.floor(Math.random() * 500);
    await daemon!.stop();
    daemon = await createDaemon({ port });
    await daemon.start();

    const responses = await new Promise<any[]>((resolve, reject) => {
      const received: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${daemon!.token}`);
      ws.once("error", reject);
      ws.once("open", () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: "bad_workflow", method: "run.create", params: { input: {}, workflowId: "missing.workflow" } }));
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: "bad_params", method: "run.create", params: { input: {}, workflowId: "fixture.echo", mode: "bogus" } }));
      });
      ws.on("message", (raw) => {
        received.push(JSON.parse(String(raw)));
        if (received.length === 2) {
          ws.close();
          resolve(received);
        }
      });
    });

    expect(responses).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "bad_workflow", error: expect.objectContaining({ code: -32004, message: "Unknown workflow: missing.workflow" }) }),
      expect.objectContaining({ id: "bad_params", error: expect.objectContaining({ code: -32602, message: "Invalid params" }) })
    ]));
  });

  test("rejects WebSocket upgrade from non-local origin", async () => {
    const port = 40400 + Math.floor(Math.random() * 1000);
    await daemon!.stop();
    daemon = await createDaemon({ port });
    await daemon.start();

    const closeOrError = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?token=${daemon!.token}`, {
        headers: { origin: "https://example.com" }
      });
      ws.once("open", () => resolve("open"));
      ws.once("unexpected-response", (_request, response) => resolve(`unexpected-response:${response.statusCode}`));
      ws.once("error", () => resolve("error"));
    });

    expect(closeOrError).not.toBe("open");
  });
});
