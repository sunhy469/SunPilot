import { describe, expect, test } from "vitest";
import type { InstalledSkillRecord, StepRecord } from "@sunpilot/protocol";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { createAgentLoopService } from "./composition-root.js";

const installedSkill: InstalledSkillRecord = {
  id: "test.files",
  name: "Test Files",
  version: "0.1.0",
  path: ".",
  enabled: true,
  manifest: {
    schemaVersion: "sunpilot.skill/v1",
    id: "test.files",
    name: "Test Files",
    version: "0.1.0",
    description: "Test file skill",
    entry: "index.ts",
    readme: "README.md",
    runtime: { node: ">=22", module: "esm" },
    permissions: {},
    capabilities: [
      {
        name: "filesystem.read",
        title: "Read File",
        description: "Read a file",
        inputSchema: {},
        outputSchema: {},
        risk: "low",
        permissions: [],
      },
    ],
  },
  installedAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
};

const highRiskSkill: InstalledSkillRecord = {
  ...installedSkill,
  id: "test.shell",
  name: "Test Shell",
  manifest: {
    ...installedSkill.manifest,
    id: "test.shell",
    name: "Test Shell",
    capabilities: [
      {
        name: "shell.execute",
        title: "Execute Shell",
        description: "Execute a shell command",
        inputSchema: {},
        outputSchema: {},
        risk: "high",
        permissions: ["shell"],
      },
    ],
  },
};

describe("createAgentLoopService", () => {
  test("creates new conversations with the Agent-assigned id", async () => {
    const db = new InMemoryDatabaseContext();
    const service = createAgentLoopService({
      database: db,
      skillRegistry: {
        list: () => [],
      } as any,
      llmProvider: {
        id: "test",
        model: "test",
        async *streamChat() {
          yield { delta: "Hello from the agent.", raw: {} };
        },
      },
    });

    const result = await service.handleChatCommand(
      { message: "hello" },
      { source: "api" },
    );

    await expect(
      db.conversations.findById(result.conversationId),
    ).resolves.toEqual(expect.objectContaining({ id: result.conversationId }));
    await expect(
      db.messages.listByConversationId(result.conversationId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "hello" }),
        expect.objectContaining({
          id: result.messageId,
          role: "assistant",
          content: "Hello from the agent.",
        }),
      ]),
    );
  });

  test("executes matched skill capabilities through SkillRunner and persists agent events", async () => {
    const db = new InMemoryDatabaseContext();
    const executedSteps: StepRecord[] = [];
    const service = createAgentLoopService({
      database: db,
      skillRegistry: {
        list: () => [installedSkill],
      } as any,
      skillRunner: {
        async execute(step: StepRecord) {
          executedSteps.push(step);
          return { content: "file contents" };
        },
      } as any,
      llmProvider: {
        id: "test",
        model: "test",
        async *streamChat() {
          yield { delta: "Tool result summarized.", raw: {} };
        },
      },
    });

    const result = await service.handleChatCommand(
      { message: "read file" },
      { source: "api" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe("completed");
    expect(executedSteps).toEqual([
      expect.objectContaining({
        runId: result.runId,
        type: "skill",
        status: "running",
        skillId: installedSkill.id,
        capability: "filesystem.read",
      }),
    ]);
    await expect(db.steps.listByRunId(result.runId)).resolves.toEqual([
      expect.objectContaining({
        id: executedSteps[0]?.id,
        status: "completed",
        output: { content: "file contents" },
      }),
    ]);
    await expect(db.toolCalls.listByRunId(result.runId)).resolves.toEqual([
      expect.objectContaining({
        id: executedSteps[0]?.id,
        runId: result.runId,
        skillId: "filesystem.read",
        status: "completed",
        riskLevel: "low",
        result: expect.objectContaining({
          summary: '{"content":"file contents"}',
        }),
      }),
    ]);
    await expect(db.modelCalls.listByRunId(result.runId)).resolves.toEqual([
      expect.objectContaining({
        provider: "test",
        model: "test",
        purpose: "response.compose",
        status: "completed",
      }),
    ]);
    const events = await db.events.listByRunId(result.runId);
    expect(
      events.filter((event) => event.type === "agent.run.created"),
    ).toHaveLength(1);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent.run.created" }),
        expect.objectContaining({ type: "agent.tool.started" }),
        expect.objectContaining({ type: "agent.tool.completed" }),
        expect.objectContaining({ type: "agent.run.completed" }),
      ]),
    );
  });

  test("resumes approved tool calls and completes the run", async () => {
    const db = new InMemoryDatabaseContext();
    const executedSteps: StepRecord[] = [];
    const service = createAgentLoopService({
      database: db,
      skillRegistry: {
        list: () => [highRiskSkill],
      } as any,
      skillRunner: {
        async execute(step: StepRecord) {
          executedSteps.push(step);
          return { content: "build passed" };
        },
      } as any,
      llmProvider: {
        id: "test",
        model: "test",
        async *streamChat() {
          yield { delta: "shell_operation", raw: {} };
        },
      },
    });

    const result = await service.handleChatCommand(
      { message: "run pnpm build" },
      { source: "api" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe("waiting_approval");
    const approvals = await db.approvals.list();
    expect(approvals).toEqual([
      expect.objectContaining({
        runId: result.runId,
        status: "pending",
        risk: "high",
        requestedAction: expect.objectContaining({
          skillId: "shell.execute",
          permissions: ["shell.execute"],
        }),
      }),
    ]);

    await expect(service.approve(approvals[0]!.id, "tester")).resolves.toEqual({
      approved: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(executedSteps).toEqual([
      expect.objectContaining({
        runId: result.runId,
        type: "skill",
        status: "running",
        skillId: highRiskSkill.id,
        capability: "shell.execute",
      }),
    ]);
    await expect(db.steps.listByRunId(result.runId)).resolves.toEqual([
      expect.objectContaining({
        id: executedSteps[0]?.id,
        status: "completed",
        output: { content: "build passed" },
      }),
    ]);
    await expect(db.toolCalls.listByRunId(result.runId)).resolves.toEqual([
      expect.objectContaining({
        id: executedSteps[0]?.id,
        runId: result.runId,
        skillId: "shell.execute",
        status: "completed",
        riskLevel: "high",
        result: expect.objectContaining({
          summary: '{"content":"build passed"}',
        }),
      }),
    ]);
    await expect(db.modelCalls.listByRunId(result.runId)).resolves.toEqual([
      expect.objectContaining({
        provider: "test",
        model: "test",
        purpose: "response.compose",
        status: "completed",
      }),
    ]);
    await expect(db.runs.findById(result.runId)).resolves.toEqual(
      expect.objectContaining({
        status: "completed",
      }),
    );
    await expect(db.approvals.findById(approvals[0]!.id)).resolves.toEqual(
      expect.objectContaining({
        status: "approved",
        decidedBy: "tester",
      }),
    );
    await expect(db.audit.list(result.runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actor: "tester",
          action: "approval.approved",
          target: approvals[0]!.id,
          risk: "high",
        }),
      ]),
    );
    const approvalEvents = await db.events.listByRunId(result.runId);
    expect(
      approvalEvents.filter(
        (event) => event.type === "agent.approval.required",
      ),
    ).toHaveLength(1);
    expect(
      approvalEvents.filter(
        (event) => event.type === "agent.approval.approved",
      ),
    ).toHaveLength(1);
    expect(approvalEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent.approval.required" }),
        expect.objectContaining({
          type: "agent.approval.approved",
          payload: expect.objectContaining({
            approvalId: approvals[0]!.id,
            decidedBy: "tester",
          }),
        }),
        expect.objectContaining({ type: "agent.tool.started" }),
        expect.objectContaining({ type: "agent.tool.completed" }),
        expect.objectContaining({ type: "agent.run.completed" }),
      ]),
    );
  });

  test("executes enabled workflows through the Agent tool loop", async () => {
    const db = new InMemoryDatabaseContext();
    await db.workflows.upsert({
      id: "daily.close",
      title: "Daily Close",
      version: "1.0.0",
      source: "local",
      enabled: true,
      definition: { description: "Close the daily business checklist." },
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    });
    const workflowRuns: Array<{
      input: unknown;
      workflowId: string | undefined;
      mode: string | undefined;
    }> = [];
    const service = createAgentLoopService({
      database: db,
      skillRegistry: {
        list: () => [],
      } as any,
      workflowRuntime: {
        async createRun(
          input: unknown,
          workflowId: string | undefined,
          mode: string | undefined,
        ) {
          workflowRuns.push({ input, workflowId, mode });
          return {
            id: "run_workflow_child",
            title: "Daily Close",
            status: "completed",
            mode: "approval_required",
            workflowId,
            createdAt: "2026-06-06T00:00:00.000Z",
            updatedAt: "2026-06-06T00:00:01.000Z",
            input,
            context: {},
          };
        },
      } as any,
      llmProvider: {
        id: "test",
        model: "test",
        async *streamChat() {
          yield { delta: "Workflow started.", raw: {} };
        },
      },
    });

    const result = await service.handleChatCommand(
      { message: "run workflow Daily Close" },
      { source: "api" },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.status).toBe("completed");
    expect(workflowRuns).toEqual([
      {
        workflowId: "daily.close",
        mode: "approval_required",
        input: expect.objectContaining({
          message: "run workflow Daily Close",
          parentAgentRunId: result.runId,
        }),
      },
    ]);
    await expect(db.toolCalls.listByRunId(result.runId)).resolves.toEqual([
      expect.objectContaining({
        runId: result.runId,
        skillId: "workflow.daily.close",
        status: "completed",
        riskLevel: "medium",
      }),
    ]);
    await expect(db.events.listByRunId(result.runId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "agent.tool.selected",
          payload: expect.objectContaining({
            skillId: "workflow.daily.close",
          }),
        }),
        expect.objectContaining({
          type: "agent.tool.completed",
          payload: expect.objectContaining({
            skillId: "workflow.daily.close",
          }),
        }),
        expect.objectContaining({ type: "agent.run.completed" }),
      ]),
    );
  });
});
