import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  AuditActor,
  type ApprovalRecord,
  type ArtifactRecord,
  type RunRecord,
  type SunPilotEvent,
} from "@sunpilot/protocol";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { createDaemon } from "./server.js";

describe("daemon Agent runtime REST routes", () => {
  let daemon: Awaited<ReturnType<typeof createDaemon>> | undefined;
  let tempDirs: string[] = [];

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("lists filtered runs, pending approvals, replayable events, and call logs", async () => {
    const db = new InMemoryDatabaseContext();
    const run: RunRecord = {
      id: "run_agent",
      title: "Agent run",
      status: "waiting_approval",
      mode: "agent",
      conversationId: "conv_agent",
      goal: "run shell",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
      input: { message: "run shell" },
      context: {},
    };
    await db.runs.create(run);
    await db.runStatusHistory.append({
      runId: run.id,
      nextStatus: "created",
      createdAt: "2026-06-06T00:00:00.000Z",
    });
    await db.runStatusHistory.append({
      runId: run.id,
      previousStatus: "created",
      nextStatus: "waiting_approval",
      reason: "requires approval",
      createdAt: "2026-06-06T00:00:01.000Z",
    });
    const approval: ApprovalRecord = {
      id: "approval_agent",
      runId: run.id,
      status: "pending",
      risk: "high",
      title: "Approve shell",
      reason: "Shell execution",
      requestedAction: { skillId: "shell.execute", arguments: {} },
      createdAt: "2026-06-06T00:00:02.000Z",
    };
    await db.approvals.create(approval);
    const event: SunPilotEvent = {
      id: "evt_agent",
      runId: run.id,
      conversationId: run.conversationId,
      type: "agent.approval.required",
      payload: { runId: run.id, approvalId: approval.id },
      createdAt: "2026-06-06T00:00:03.000Z",
    };
    await db.events.append(event);
    await db.toolCalls.create({
      id: "tool_agent",
      runId: run.id,
      skillId: "shell.execute",
      name: "Execute Shell",
      riskLevel: "high",
      status: "running",
      startedAt: "2026-06-06T00:00:03.000Z",
    });
    await db.toolCalls.updateStatus("tool_agent", "completed", {
      completedAt: "2026-06-06T00:00:04.000Z",
    });
    await db.modelCalls.create({
      id: "model_agent",
      runId: run.id,
      provider: "test",
      model: "test",
      purpose: "response_composition",
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 150,
      status: "completed",
    });
    await db.audit.create({
      runId: run.id,
      actor: "test",
      action: "first",
      target: "run_agent",
      payload: {},
      createdAt: "2026-06-06T00:00:04.000Z",
    });
    await db.audit.create({
      runId: run.id,
      actor: "test",
      action: "second",
      target: "run_agent",
      payload: {},
      createdAt: "2026-06-06T00:00:05.000Z",
    });

    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    const runs = await daemon.app.inject({
      method: "GET",
      url: "/v1/runs?status=waiting_approval&mode=agent&conversationId=conv_agent",
    });
    expect(runs.statusCode).toBe(200);
    expect(runs.json()).toEqual({
      items: [
        expect.objectContaining({ id: run.id, status: "waiting_approval" }),
      ],
    });

    const approvals = await daemon.app.inject({
      method: "GET",
      url: "/v1/approvals?status=pending&runId=run_agent",
    });
    expect(approvals.statusCode).toBe(200);
    expect(approvals.json()).toEqual({
      items: [expect.objectContaining({ id: approval.id, status: "pending" })],
    });

    const replay = await daemon.app.inject({
      method: "GET",
      url: "/v1/conversations/conv_agent/events?afterSequence=0",
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({
      conversationId: "conv_agent",
      items: expect.arrayContaining([
        expect.objectContaining({ id: event.id, sequence: 1 }),
      ]),
    });

    const statusHistory = await daemon.app.inject({
      method: "GET",
      url: "/v1/runs/run_agent/status-history",
    });
    expect(statusHistory.statusCode).toBe(200);
    expect(statusHistory.json()).toEqual({
      runId: run.id,
      items: [
        expect.objectContaining({ nextStatus: "created" }),
        expect.objectContaining({ nextStatus: "waiting_approval" }),
      ],
    });

    const toolCalls = await daemon.app.inject({
      method: "GET",
      url: "/v1/runs/run_agent/tool-calls",
    });
    expect(toolCalls.statusCode).toBe(200);
    expect(toolCalls.json()).toEqual({
      runId: run.id,
      items: [
        expect.objectContaining({ id: "tool_agent", skillId: "shell.execute" }),
      ],
    });

    const modelCalls = await daemon.app.inject({
      method: "GET",
      url: "/v1/runs/run_agent/model-calls",
    });
    expect(modelCalls.statusCode).toBe(200);
    expect(modelCalls.json()).toEqual({
      runId: run.id,
      items: [
        expect.objectContaining({
          id: "model_agent",
          purpose: "response_composition",
        }),
      ],
    });

    const diagnostics = await daemon.app.inject({
      method: "GET",
      url: "/v1/diagnostics",
    });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.json()).toEqual({
      daemon: expect.objectContaining({
        status: "ok",
        pid: expect.any(Number),
        uptimeSec: expect.any(Number),
      }),
      database: expect.objectContaining({
        status: "ok",
        latencyMs: expect.any(Number),
      }),
      llm: expect.objectContaining({
        configured: expect.any(Boolean),
        provider: "openai-compatible",
        model: expect.any(String),
      }),
      skills: expect.objectContaining({
        count: expect.any(Number),
        enabled: expect.any(Number),
      }),
      runs: {
        active: 0,
        waitingApproval: 1,
      },
      websocket: {
        connections: 0,
      },
    });

    const metrics = await daemon.app.inject({
      method: "GET",
      url: "/metrics",
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain");
    expect(metrics.body).toContain("sunpilot_runs_active");
    expect(metrics.body).toContain(
      'sunpilot_runs_total{status="waiting_approval",mode="agent"} 1',
    );
    expect(metrics.body).toContain(
      'sunpilot_model_calls_total{provider="test",model="test",purpose="response_composition",status="completed"} 1',
    );
    expect(metrics.body).toContain(
      'sunpilot_model_tokens_total{provider="test",model="test",type="input"} 10',
    );
    expect(metrics.body).toContain(
      'sunpilot_tool_calls_total{skill_id="shell.execute",status="completed",risk_level="high"} 1',
    );
    expect(metrics.body).toContain(
      'sunpilot_events_persisted_total{type="agent.approval.required"} 2',
    );
    expect(metrics.body).toContain("sunpilot_model_latency_ms_bucket");
    expect(metrics.body).toContain("sunpilot_tool_latency_ms_bucket");
    expect(metrics.body).toContain("sunpilot_run_duration_ms_bucket");
    expect(metrics.body).toContain("sunpilot_ws_reconnects_total 0");
    expect(metrics.body).toContain(
      "sunpilot_memory_retrieval_latency_ms_bucket",
    );
    expect(metrics.body).toContain("sunpilot_approvals_pending 1");
    expect(metrics.body).toContain("sunpilot_ws_connections 0");

    const auditLogs = await daemon.app.inject({
      method: "GET",
      url: "/v1/audit-logs?runId=run_agent&limit=1",
    });
    expect(auditLogs.statusCode).toBe(200);
    expect(auditLogs.json()).toEqual([
      expect.objectContaining({ action: "first" }),
    ]);
  });

  test("expires stale approvals on daemon startup and cancels waiting runs", async () => {
    const db = new InMemoryDatabaseContext();
    const run: RunRecord = {
      id: "run_expired",
      title: "Expired approval run",
      status: "waiting_approval",
      mode: "agent",
      conversationId: "conv_expired",
      goal: "run old command",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
      input: { message: "run old command" },
      context: {
        statusHistory: [
          {
            nextStatus: "waiting_approval",
            actor: AuditActor.System,
            createdAt: "2026-06-06T00:00:01.000Z",
          },
        ],
      },
    };
    await db.runs.create(run);
    await db.approvals.create({
      id: "approval_expired",
      runId: run.id,
      status: "pending",
      risk: "high",
      title: "Approve old command",
      reason: "Expired test",
      requestedAction: { skillId: "shell.execute", arguments: {} },
      createdAt: "2026-06-06T00:00:02.000Z",
      expiresAt: "2026-06-06T00:00:03.000Z",
    });

    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    await expect(db.approvals.findById("approval_expired")).resolves.toEqual(
      expect.objectContaining({ status: "expired" }),
    );
    await expect(db.runs.findById(run.id)).resolves.toEqual(
      expect.objectContaining({ status: "cancelled" }),
    );
    await expect(db.audit.list(run.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "approval.expired",
          target: "approval_expired",
          actor: AuditActor.Daemon,
        }),
      ]),
    );
    await expect(db.events.listByRunId(run.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.approval.expired",
          payload: expect.objectContaining({
            approvalId: "approval_expired",
            runCancelled: true,
          }),
        }),
        expect.objectContaining({ type: "agent.run.cancelled" }),
      ]),
    );
  });

  test("recovers unfinished Agent runs on daemon startup", async () => {
    const db = new InMemoryDatabaseContext();
    const baseRun = {
      title: "Agent recovery",
      mode: "agent" as const,
      conversationId: "conv_recovery",
      goal: "recover me",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
      input: { message: "recover me" },
      context: {},
    };
    await db.runs.create({
      ...baseRun,
      id: "run_executing",
      status: "executing",
    });
    await db.steps.create({
      id: "step_executing",
      runId: "run_executing",
      type: "skill",
      name: "Execute tool",
      status: "running",
      input: {},
    });
    await db.runs.create({
      ...baseRun,
      id: "run_responding",
      status: "responding",
    });
    await db.runs.create({
      ...baseRun,
      id: "run_waiting",
      status: "waiting_approval",
    });
    await db.approvals.create({
      id: "approval_waiting",
      runId: "run_waiting",
      status: "pending",
      risk: "high",
      title: "Approve recovered action",
      reason: "Recovery snapshot",
      requestedAction: { skillId: "shell.execute", arguments: {} },
      createdAt: "2026-06-06T00:00:02.000Z",
    });

    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    await expect(db.runs.findById("run_executing")).resolves.toEqual(
      expect.objectContaining({
        status: "interrupted",
        error: expect.objectContaining({
          code: "AGENT_RUN_INTERRUPTED",
          retryable: true,
        }),
      }),
    );
    await expect(db.steps.listByRunId("run_executing")).resolves.toEqual([
      expect.objectContaining({ id: "step_executing", status: "interrupted" }),
    ]);
    await expect(db.runs.findById("run_responding")).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({
          code: "AGENT_RUN_RECOVERY_REQUIRED",
          retryable: true,
        }),
      }),
    );
    await expect(db.runs.findById("run_waiting")).resolves.toEqual(
      expect.objectContaining({ status: "waiting_approval" }),
    );
    await expect(db.events.listByRunId("run_executing")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent.run.interrupted" }),
      ]),
    );
    await expect(db.events.listByRunId("run_responding")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent.run.failed" }),
      ]),
    );
    await expect(db.events.listByRunId("run_waiting")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.approval.required",
          payload: expect.objectContaining({
            approvalId: "approval_waiting",
            recovered: true,
          }),
        }),
      ]),
    );
    await expect(db.audit.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "daemon.recovery_scan",
          target: "agent-runtime",
          payload: expect.objectContaining({
            interruptedRuns: ["run_executing"],
            failedRuns: ["run_responding"],
            snapshottedApprovals: ["approval_waiting"],
          }),
        }),
      ]),
    );
  });

  test("reads conversations through the REST detail route", async () => {
    const db = new InMemoryDatabaseContext();
    const conversation = await db.conversations.create({
      id: "conv_detail",
      title: "Detail view",
    });
    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    const response = await daemon.app.inject({
      method: "GET",
      url: "/v1/conversations/conv_detail",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(conversation);

    const missing = await daemon.app.inject({
      method: "GET",
      url: "/v1/conversations/missing",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
  });

  test("paginates conversations with an opaque cursor", async () => {
    const db = new InMemoryDatabaseContext();
    await db.conversations.create({ id: "conv_a", title: "A" });
    await db.conversations.create({ id: "conv_b", title: "B" });
    await db.conversations.create({ id: "conv_c", title: "C" });
    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    const first = await daemon.app.inject({
      method: "GET",
      url: "/v1/conversations?limit=2",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(2);
    expect(first.json().nextCursor).toEqual(expect.any(String));

    const second = await daemon.app.inject({
      method: "GET",
      url: `/v1/conversations?limit=2&cursor=${encodeURIComponent(
        first.json().nextCursor,
      )}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().nextCursor).toBeUndefined();
  });

  test("paginates runs with an opaque cursor", async () => {
    const db = new InMemoryDatabaseContext();
    const baseRun = {
      title: "Paged run",
      status: "completed" as const,
      mode: "agent" as const,
      conversationId: "conv_runs",
      goal: "page",
      input: {},
      context: {},
    };
    await db.runs.create({
      ...baseRun,
      id: "run_a",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
    await db.runs.create({
      ...baseRun,
      id: "run_b",
      createdAt: "2026-06-06T00:00:01.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
    });
    await db.runs.create({
      ...baseRun,
      id: "run_c",
      createdAt: "2026-06-06T00:00:02.000Z",
      updatedAt: "2026-06-06T00:00:02.000Z",
    });
    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    const first = await daemon.app.inject({
      method: "GET",
      url: "/v1/runs?mode=agent&status=completed&limit=2",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().items.map((run: RunRecord) => run.id)).toEqual([
      "run_c",
      "run_b",
    ]);
    expect(first.json().nextCursor).toEqual(expect.any(String));

    const second = await daemon.app.inject({
      method: "GET",
      url: `/v1/runs?mode=agent&status=completed&limit=2&cursor=${encodeURIComponent(
        first.json().nextCursor,
      )}`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().items.map((run: RunRecord) => run.id)).toEqual([
      "run_a",
    ]);
    expect(second.json().nextCursor).toBeUndefined();
  });

  test("cancels Agent runs through the Agent service REST path", async () => {
    const db = new InMemoryDatabaseContext();
    const cancelled: string[] = [];
    daemon = await createDaemon({
      database: db,
      port: 3737,
      chatAgent: {
        startChatCommand: async () => {
          throw new Error("not used");
        },
        handleChatCommand: async () => {
          throw new Error("not used");
        },
        stopChat: () => ({ stopped: false, runId: "unused" }),
        cancelRun: async (runId: string) => {
          cancelled.push(runId);
          return { cancelled: true, runId, stopped: false };
        },
        resumeRun: async (runId: string) => ({
          resumed: true,
          originalRunId: runId,
          runId: "run_resumed",
          conversationId: "conv_agent",
          messageId: "msg_resumed",
          status: "completed",
        }),
        retryRun: async (runId: string) => ({
          retried: true,
          originalRunId: runId,
          runId: "run_retry",
          conversationId: "conv_agent",
          messageId: "msg_retry",
          status: "completed",
        }),
        approve: async () => ({ approved: true }),
        reject: async () => ({ rejected: true, runId: "run_test", strategy: "interrupt" }),
      },
    });

    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/runs/run_old/cancel",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      cancelled: true,
      runId: "run_old",
      stopped: false,
    });
    expect(cancelled).toEqual(["run_old"]);
  });

  test("retries Agent runs through the Agent service REST path", async () => {
    const db = new InMemoryDatabaseContext();
    const retried: string[] = [];
    daemon = await createDaemon({
      database: db,
      port: 3737,
      chatAgent: {
        startChatCommand: async () => {
          throw new Error("not used");
        },
        handleChatCommand: async () => {
          throw new Error("not used");
        },
        stopChat: () => ({ stopped: false, runId: "unused" }),
        cancelRun: async (runId: string) => ({
          cancelled: true,
          runId,
          stopped: false,
        }),
        resumeRun: async (runId: string) => ({
          resumed: true,
          originalRunId: runId,
          runId: "run_resumed",
          conversationId: "conv_agent",
          messageId: "msg_resumed",
          status: "completed",
        }),
        retryRun: async (runId: string) => {
          retried.push(runId);
          return {
            retried: true,
            originalRunId: runId,
            runId: "run_retry",
            conversationId: "conv_agent",
            messageId: "msg_retry",
            status: "completed",
          };
        },
        approve: async () => ({ approved: true }),
        reject: async () => ({ rejected: true, runId: "run_test", strategy: "interrupt" }),
      },
    });

    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/runs/run_old/retry",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      retried: true,
      originalRunId: "run_old",
      runId: "run_retry",
      conversationId: "conv_agent",
      messageId: "msg_retry",
      status: "completed",
    });
    expect(retried).toEqual(["run_old"]);
  });

  test("resumes Agent runs through the Agent service REST path", async () => {
    const db = new InMemoryDatabaseContext();
    const resumed: string[] = [];
    daemon = await createDaemon({
      database: db,
      port: 3737,
      chatAgent: {
        startChatCommand: async () => {
          throw new Error("not used");
        },
        handleChatCommand: async () => {
          throw new Error("not used");
        },
        stopChat: () => ({ stopped: false, runId: "unused" }),
        cancelRun: async (runId: string) => ({
          cancelled: true,
          runId,
          stopped: false,
        }),
        resumeRun: async (runId: string) => {
          resumed.push(runId);
          return {
            resumed: true,
            originalRunId: runId,
            runId: "run_resumed",
            conversationId: "conv_agent",
            messageId: "msg_resumed",
            status: "completed",
          };
        },
        retryRun: async (runId: string) => ({
          retried: true,
          originalRunId: runId,
          runId: "run_retry",
          conversationId: "conv_agent",
          messageId: "msg_retry",
          status: "completed",
        }),
        approve: async () => ({ approved: true }),
        reject: async () => ({ rejected: true, runId: "run_test", strategy: "interrupt" }),
      },
    });

    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/runs/run_old/resume",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      resumed: true,
      originalRunId: "run_old",
      runId: "run_resumed",
      conversationId: "conv_agent",
      messageId: "msg_resumed",
      status: "completed",
    });
    expect(resumed).toEqual(["run_old"]);
  });

  test("approves Agent approvals through the Agent service REST path", async () => {
    const db = new InMemoryDatabaseContext();
    const approved: Array<{ approvalId: string; actor?: string }> = [];
    daemon = await createDaemon({
      database: db,
      port: 3737,
      chatAgent: {
        startChatCommand: async () => {
          throw new Error("not used");
        },
        handleChatCommand: async () => {
          throw new Error("not used");
        },
        stopChat: () => ({ stopped: false, runId: "unused" }),
        cancelRun: async (runId: string) => ({
          cancelled: true,
          runId,
          stopped: false,
        }),
        resumeRun: async (runId: string) => ({
          resumed: true,
          originalRunId: runId,
          runId: "run_resumed",
          conversationId: "conv_agent",
          messageId: "msg_resumed",
          status: "completed",
        }),
        retryRun: async (runId: string) => ({
          retried: true,
          originalRunId: runId,
          runId: "run_retry",
          conversationId: "conv_agent",
          messageId: "msg_retry",
          status: "completed",
        }),
        approve: async (approvalId: string, actor?: string) => {
          approved.push({ approvalId, actor });
          return { approved: true };
        },
        reject: async () => ({ rejected: true, runId: "run_test", strategy: "interrupt" }),
      },
    });

    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/approvals/approval_agent/approve",
      payload: { actor: "web" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ approved: true });
    expect(approved).toEqual([{ approvalId: "approval_agent", actor: "web" }]);
  });

  test("rejects Agent approvals through the Agent service REST path", async () => {
    const db = new InMemoryDatabaseContext();
    const rejected: Array<{
      approvalId: string;
      actor?: string;
      reason?: string;
    }> = [];
    daemon = await createDaemon({
      database: db,
      port: 3737,
      chatAgent: {
        startChatCommand: async () => {
          throw new Error("not used");
        },
        handleChatCommand: async () => {
          throw new Error("not used");
        },
        stopChat: () => ({ stopped: false, runId: "unused" }),
        cancelRun: async (runId: string) => ({
          cancelled: true,
          runId,
          stopped: false,
        }),
        resumeRun: async (runId: string) => ({
          resumed: true,
          originalRunId: runId,
          runId: "run_resumed",
          conversationId: "conv_agent",
          messageId: "msg_resumed",
          status: "completed",
        }),
        retryRun: async (runId: string) => ({
          retried: true,
          originalRunId: runId,
          runId: "run_retry",
          conversationId: "conv_agent",
          messageId: "msg_retry",
          status: "completed",
        }),
        approve: async () => ({ approved: true }),
        reject: async (
          approvalId: string,
          actor?: string,
          reason?: string,
          _strategy?: string,
        ) => {
          rejected.push({ approvalId, actor, reason });
          return { rejected: true, runId: "run_test", strategy: "interrupt" };
        },
      },
    });

    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/approvals/approval_agent/reject",
      payload: { actor: "web", reason: "too risky" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ rejected: true }),
    );
    expect(rejected).toEqual([
      { approvalId: "approval_agent", actor: "web", reason: "too risky" },
    ]);
  });

  test("returns 409 and keeps approval pending when the approval is not resumable", async () => {
    const db = new InMemoryDatabaseContext();
    await db.runs.create({
      id: "run_non_resumable",
      title: "Non resumable approval",
      status: "waiting_approval",
      mode: "agent",
      conversationId: "conv_non_resumable",
      input: {},
      context: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
    await db.approvals.create({
      id: "approval_non_resumable",
      runId: "run_non_resumable",
      status: "pending",
      risk: "high",
      title: "Approve legacy action",
      reason: "No resumable action payload",
      requestedAction: { capability: "legacy.execute" },
      createdAt: "2026-06-06T00:00:00.000Z",
    });
    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/approvals/approval_non_resumable/approve",
      payload: { actor: "web" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "approval_not_resumable",
      message:
        "Approval approval_non_resumable does not include a resumable action",
    });
    await expect(db.approvals.findById("approval_non_resumable")).resolves.toEqual(
      expect.objectContaining({ status: "pending" }),
    );
  });

  test("rejects the legacy run creation endpoint", async () => {
    const db = new InMemoryDatabaseContext();
    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    const response = await daemon.app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: { mode: "agent", input: { message: "test" } },
    });

    expect(response.statusCode).toBe(404);
  });

  test("lists artifact metadata and streams artifact content through REST", async () => {
    const db = new InMemoryDatabaseContext();
    const artifactDir = mkdtempSync(join(tmpdir(), "sunpilot-artifact-"));
    tempDirs.push(artifactDir);
    const artifactPath = join(artifactDir, "report.md");
    writeFileSync(artifactPath, "# Report\n\nDone.\n");
    const artifact: ArtifactRecord = {
      id: "artifact_report",
      runId: "run_artifact",
      type: "markdown",
      name: "report.md",
      path: artifactPath,
      mimeType: "text/markdown",
      sizeBytes: 16,
      metadata: { producer: "test" },
      createdAt: "2026-06-06T00:00:00.000Z",
    };
    await db.artifacts.create(artifact);
    await db.artifacts.create({
      ...artifact,
      id: "artifact_other",
      runId: "run_other",
      name: "other.md",
    });
    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    const listed = await daemon.app.inject({
      method: "GET",
      url: "/v1/artifacts?runId=run_artifact",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([artifact]);

    const metadata = await daemon.app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact_report",
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toEqual(artifact);

    const content = await daemon.app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact_report/content",
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toContain("text/markdown");
    expect(content.body).toBe("# Report\n\nDone.\n");
  });

  test("creates, searches, and soft-deletes memory through REST", async () => {
    const db = new InMemoryDatabaseContext();
    daemon = await createDaemon({
      database: db,
      port: 3737,
    });

    const created = await daemon.app.inject({
      method: "POST",
      url: "/v1/memory",
      payload: {
        key: "project.stack",
        value: "TypeScript monorepo",
        scope: "project",
        scopeId: "sunpilot",
        type: "technical_stack",
        title: "Project stack",
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({
      item: expect.objectContaining({
        key: "project.stack",
        scope: "project",
        type: "technical_stack",
      }),
    });

    const listed = await daemon.app.inject({
      method: "GET",
      url: "/v1/memory?query=TypeScript&projectId=sunpilot&scope=project",
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      items: [
        expect.objectContaining({
          key: "project.stack",
          score: expect.any(Number),
        }),
      ],
    });

    const memoryId = created.json().item.id;
    const patched = await daemon.app.inject({
      method: "PATCH",
      url: `/v1/memory/${memoryId}`,
      payload: {
        value: "TypeScript monorepo with PostgreSQL",
        content: "TypeScript monorepo with PostgreSQL",
        title: "Updated project stack",
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({
      item: expect.objectContaining({
        id: memoryId,
        title: "Updated project stack",
        content: "TypeScript monorepo with PostgreSQL",
      }),
    });
    const patchedSearch = await daemon.app.inject({
      method: "GET",
      url: "/v1/memory?query=PostgreSQL&projectId=sunpilot&scope=project",
    });
    expect(patchedSearch.json()).toEqual({
      items: [expect.objectContaining({ id: memoryId })],
    });

    const deleted = await daemon.app.inject({
      method: "DELETE",
      url: `/v1/memory/${memoryId}`,
      payload: { reason: "test cleanup" },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ ok: true, id: memoryId });
    await expect(
      db.memory.list({ includeDeleted: true, projectId: "sunpilot" }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: memoryId,
        deletedAt: expect.any(String),
        metadata: expect.objectContaining({ deleteReason: "test cleanup" }),
      }),
    ]);
  });
});
