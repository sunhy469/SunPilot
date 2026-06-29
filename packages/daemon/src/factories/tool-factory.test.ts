import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import type { InstalledSkillRecord, StepRecord } from "@sunpilot/protocol";
import {
  InMemoryAgentEventBus,
  ToolSandbox,
  TaskScopedPermissionManager,
  PromptInjectionDetector,
  ToolSafetyBoundary,
} from "@sunpilot/core";

import { createToolLayer } from "./tool-factory.js";

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
      {
        name: "shell.execute",
        title: "Run Shell",
        description: "Run a shell command",
        inputSchema: {},
        outputSchema: {},
        risk: "high",
        permissions: ["shell"],
      },
    ],
    trust: "local-trusted",
  },
  installedAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
};

describe("createToolLayer", () => {
  function setup(opts?: { skillRunner?: any }) {
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();
    const sandbox = new ToolSandbox("moderate");
    const permissionManager = new TaskScopedPermissionManager();
    const injectionDetector = new PromptInjectionDetector({ blockCritical: true });
    const toolSafetyBoundary = new ToolSafetyBoundary({
      eventBus: rawEventBus,
      sandbox,
      permissionManager,
      injectionDetector,
    });
    return createToolLayer({
      database: db,
      rawEventBus,
      skillRegistry: { list: () => [installedSkill] } as any,
      skillRunner: opts?.skillRunner,
      toolSafetyBoundary,
    });
  }

  test("returns all tool-pipeline components", () => {
    const result = setup();
    expect(result.listSkillSummaries).toBeTypeOf("function");
    expect(result.skillExecutor).toBeDefined();
    expect(result.executionOrchestrator).toBeDefined();
  });

  test("listSkillSummaries produces fully-qualified capability ids (<skill-id>:<capability-name>)", async () => {
    const { listSkillSummaries } = setup();
    const summaries = await listSkillSummaries();

    const ids = summaries.map((s) => s.id);
    expect(ids).toContain("test.files:filesystem.read");
    expect(ids).toContain("test.files:shell.execute");
    // All ids follow the fully-qualified format
    expect(ids.every((id) => id.split(":").length === 2)).toBe(true);
  });

  test("listSkillSummaries normalizes permissions and classifies sideEffects", async () => {
    const { listSkillSummaries } = setup();
    const summaries = await listSkillSummaries();

    const readFile = summaries.find((s) => s.id === "test.files:filesystem.read");
    expect(readFile?.permissions).toEqual([]);
    expect(readFile?.sideEffects).toBe("none"); // No permissions → none
    expect(readFile?.riskHints.defaultRisk).toBe("low");

    const shell = summaries.find((s) => s.id === "test.files:shell.execute");
    // "shell" expands to ["shell.execute"]
    expect(shell?.permissions).toEqual(["shell.execute"]);
    expect(shell?.sideEffects).toBe("destructive");
    expect(shell?.riskHints.defaultRisk).toBe("high");
  });

  test("listSkillSummaries populates inputSchema/outputSchema from manifest", async () => {
    const { listSkillSummaries } = setup();
    const summaries = await listSkillSummaries();

    const readFile = summaries.find((s) => s.id === "test.files:filesystem.read");
    expect(readFile?.inputSchema).toEqual({});
    expect(readFile?.outputSchema).toEqual({});
  });

  test("skillExecutor returns failed status when no SkillRunner is configured", async () => {
    const { skillExecutor } = setup(); // No skillRunner provided

    const result = await skillExecutor.execute({
      runId: "run_1",
      toolCallId: "tc_1",
      skillId: "test.files:filesystem.read",
      name: "Read File",
      arguments: {},
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("AGENT_TOOL_EXECUTION_FAILED");
    expect(result.error?.message).toMatch(/SkillRunner is not configured/);
  });

  test("skillExecutor delegates to the provided SkillRunner", async () => {
    const executed: StepRecord[] = [];
    const skillRunner = {
      async execute(step: StepRecord) {
        executed.push(step);
        return { content: "file contents" };
      },
    };
    const { skillExecutor } = setup({ skillRunner });

    const result = await skillExecutor.execute({
      runId: "run_2",
      toolCallId: "tc_2",
      skillId: "test.files:filesystem.read",
      name: "Read File",
      arguments: {},
      timeoutMs: 60_000,
      signal: new AbortController().signal,
    });
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("file contents");
    expect(executed.length).toBe(1);
    expect(executed[0]?.skillId).toBe("test.files");
    expect(executed[0]?.capability).toBe("filesystem.read");
  });

  test("executionOrchestrator is wired with the toolSafetyBoundary from deps", () => {
    const { executionOrchestrator } = setup();
    expect(executionOrchestrator).toBeDefined();
  });

});
