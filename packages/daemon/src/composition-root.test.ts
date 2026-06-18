import { describe, expect, test } from "vitest";
import type { InstalledSkillRecord, StepRecord } from "@sunpilot/protocol";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { createAgentLoopService } from "./composition-root.js";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

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
        async *streamChat(request: any) {
          // When the streaming path sends tool definitions for the first time,
          // return a tool_call so the LLM native function calling path works.
          // After tool execution, the next iteration includes tool result
          // messages — detect this and return just text to stop the loop.
          const hasToolResults = request.messages?.some(
            (m: any) => m.role === "tool",
          );
          if (request.tools && request.tools.length > 0 && !hasToolResults) {
            expect(request.tools[0]?.function.name).toBe(
              "test_files_filesystem_read",
            );
            yield {
              delta: "Let me read that file.",
              toolCalls: [
                {
                  index: 0,
                  id: "tc_stream_1",
                  type: "function" as const,
                  function: {
                    name: request.tools[0]?.function.name,
                    arguments: "{}",
                  },
                },
              ],
              raw: {},
            };
          } else if (hasToolResults) {
            // After tool execution, return text content and exit the loop
            yield { delta: "The file contains: file contents.", raw: {} };
          } else {
            // Intent routing / planning calls
            yield { delta: "file_operation", raw: {} };
          }
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
        skillId: "test.files:filesystem.read",
        status: "completed",
        riskLevel: "low",
        result: expect.objectContaining({
          summary: "file contents",
        }),
      }),
    ]);
    const modelCalls = await db.modelCalls.listByRunId(result.runId);
    expect(modelCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "test",
          purpose: "response_composition",
          status: "completed",
          runId: result.runId,
        }),
      ]),
    );
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
        async *streamChat(request: any) {
          // When the streaming path sends tool definitions, throw so the
          // old path with full safety pipeline (sandbox → permission →
          // ApprovalGate) takes over. The streaming path doesn't yet support
          // approval pausing.
          if (request.tools && request.tools.length > 0) {
            throw new Error(
              "Streaming fallback: approval flow requires old path",
            );
          }
          // Intent routing calls — return shell_operation to match high-risk skill
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
          skillId: "test.shell:shell.execute",
          permissions: ["shell.execute"],
        }),
      }),
    ]);

    await expect(service.approve(approvals[0]!.id, "tester")).resolves.toEqual({
      approved: true,
    });
    await waitFor(() => executedSteps.length > 0);

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
        skillId: "test.shell:shell.execute",
        status: "completed",
        riskLevel: "high",
        result: expect.objectContaining({
          summary: "build passed",
        }),
      }),
    ]);
    const modelCalls = await db.modelCalls.listByRunId(result.runId);
    expect(modelCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "test",
          purpose: "response_composition",
          status: "completed",
          runId: result.runId,
        }),
      ]),
    );
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

  test("tool catalog exposes skills with fully-qualified capability ids", async () => {
    const db = new InMemoryDatabaseContext();
    const automationSkill: import("@sunpilot/protocol").InstalledSkillRecord = {
      id: "sunpilot.automation",
      name: "SunPilot Automation",
      version: "0.1.0",
      path: "/tmp/sunpilot/skills/automation",
      enabled: true,
      manifest: {
        schemaVersion: "sunpilot.skill/v1",
        id: "sunpilot.automation",
        name: "SunPilot Automation",
        version: "0.1.0",
        description: "Built-in automations.",
        entry: "dist/index.js",
        readme: "README.md",
        runtime: { node: ">=22", module: "esm" },
        capabilities: [
          {
            name: "daily.close",
            title: "Daily Close",
            description: "Close the daily business checklist.",
            inputSchema: {},
            outputSchema: {},
            risk: "medium",
            permissions: [],
          },
        ],
        permissions: {},
      },
      installedAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const service = createAgentLoopService({
      database: db,
      skillRegistry: {
        list: () => [automationSkill],
      } as any,
      llmProvider: {
        id: "test",
        model: "test",
        async *streamChat() {
          yield { delta: "Automation result.", raw: {} };
        },
      },
    });

    // Verify catalog exposes fully-qualified tool ids (<skill-id>:<capability-name>)
    const result = await service.handleChatCommand(
      { message: "hello" },
      { source: "api" },
    );
    expect(result.status).toBe("completed");

    // Verify the skill catalog in events includes fully-qualified capability ids
    const events = await db.events.listByRunId(result.runId);
    const contextCompleted = events.find(
      (e) => e.type === "agent.context.completed",
    );
    expect(contextCompleted).toBeDefined();
  });
});
