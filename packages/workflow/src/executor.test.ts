import { describe, expect, test } from "vitest";
import {
  WorkflowToolExecutor,
  type WorkflowToolExecutorDeps,
  type WorkflowToolInput,
} from "./executor.js";

function createDeps() {
  const steps: Array<{
    id: string;
    runId: string;
    type: string;
    name: string;
    status: string;
    skillId?: string;
    input?: unknown;
  }> = [];
  const stepStatuses = new Map<
    string,
    { status: string; output?: unknown; error?: unknown }
  >();

  const deps: WorkflowToolExecutorDeps = {
    findWorkflow: async (_id: string) => null,
    getRun: async (_runId: string) => undefined,
    createStep: async (step) => {
      steps.push(step);
    },
    updateStepStatus: async (id, status, output, error) => {
      stepStatuses.set(id, { status, output, error });
    },
  };

  return { deps, steps, stepStatuses };
}

function createInput(
  overrides: Partial<WorkflowToolInput> = {},
): WorkflowToolInput {
  return {
    workflowId: "wf_test",
    runId: "run_test",
    toolCallId: "tc_test",
    arguments: { key: "value" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("WorkflowToolExecutor", () => {
  // ── workflow not found → step created + failed ──────────────────
  test("creates step and fails when workflow is not found", async () => {
    const { deps, steps, stepStatuses } = createDeps();
    deps.findWorkflow = async () => null;
    deps.getRun = async () => ({
      id: "run_test",
      title: "Test Run",
      status: "executing",
      mode: "agent",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
      input: {},
      context: {},
    });

    const executor = new WorkflowToolExecutor(deps);
    const result = await executor.execute(createInput());

    // Step created with running status before early-exit check
    expect(steps).toEqual([
      expect.objectContaining({
        id: "tc_test",
        runId: "run_test",
        type: "skill",
        name: "workflow.wf_test", // falls back to id when no title
        status: "running",
        skillId: "workflow.wf_test",
        input: { key: "value" },
      }),
    ]);

    // Step updated to failed
    expect(stepStatuses.get("tc_test")).toEqual({
      status: "failed",
      output: undefined,
      error: {
        code: "AGENT_TOOL_NOT_FOUND",
        message: "Workflow wf_test not found.",
      },
    });

    // Result reflects failure
    expect(result).toEqual({
      status: "failed",
      summary: "Workflow wf_test not found.",
      artifacts: [],
      error: {
        code: "AGENT_TOOL_NOT_FOUND",
        message: "Workflow wf_test not found.",
      },
    });
  });

  // ── run not found → step created + failed ───────────────────────
  test("creates step and fails when run is not found", async () => {
    const { deps, steps, stepStatuses } = createDeps();
    deps.findWorkflow = async () => ({
      id: "wf_test",
      title: "Test Workflow",
      version: "1.0.0",
      source: "builtin",
      enabled: true,
      definition: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
    });
    deps.getRun = async () => undefined; // run not found

    const executor = new WorkflowToolExecutor(deps);
    const result = await executor.execute(createInput());

    // Step created with workflow title in name
    expect(steps).toEqual([
      expect.objectContaining({
        id: "tc_test",
        runId: "run_test",
        type: "skill",
        name: "Test Workflow",
        status: "running",
        skillId: "workflow.wf_test",
      }),
    ]);

    // Step updated to failed — run not found
    expect(stepStatuses.get("tc_test")).toEqual({
      status: "failed",
      output: undefined,
      error: {
        code: "AGENT_RUN_NOT_FOUND",
        message: "Run run_test not found.",
      },
    });

    expect(result).toEqual({
      status: "failed",
      summary: "Run run_test not found.",
      artifacts: [],
      error: {
        code: "AGENT_RUN_NOT_FOUND",
        message: "Run run_test not found.",
      },
    });
  });

  // ── signal before execution → step created + cancelled ──────────
  test("creates step and cancels when signal is already aborted", async () => {
    const { deps, steps, stepStatuses } = createDeps();
    // Workflow and run exist, but signal is already aborted
    deps.findWorkflow = async () => ({
      id: "wf_test",
      title: "Test Workflow",
      version: "1.0.0",
      source: "builtin",
      enabled: true,
      definition: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
    });
    deps.getRun = async () => ({
      id: "run_test",
      title: "Test Run",
      status: "executing",
      mode: "agent",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
      input: {},
      context: {},
    });

    const abortController = new AbortController();
    abortController.abort(); // abort before passing to executor

    const executor = new WorkflowToolExecutor(deps);
    const result = await executor.execute(
      createInput({ signal: abortController.signal }),
    );

    // Step created, then cancelled (early-exit before execution)
    expect(steps).toEqual([
      expect.objectContaining({
        id: "tc_test",
        status: "running",
      }),
    ]);

    expect(stepStatuses.get("tc_test")).toEqual({
      status: "cancelled",
      output: undefined,
      error: {
        code: "AGENT_RUN_CANCELLED",
        message: "Workflow cancelled before execution.",
      },
    });

    expect(result).toEqual({
      status: "cancelled",
      summary: "Workflow cancelled before execution.",
      artifacts: [],
      error: {
        code: "AGENT_RUN_CANCELLED",
        message: "Workflow cancelled.",
      },
    });

    // Verify we did NOT call getRun (early exit before run validation)
    // The step was created but the run fetch was skipped due to aborted signal
  });

  // ── success → step completed ────────────────────────────────────
  test("creates step and completes on successful execution", async () => {
    const { deps, steps, stepStatuses } = createDeps();
    deps.findWorkflow = async () => ({
      id: "wf_test",
      title: "Test Workflow",
      version: "1.0.0",
      source: "builtin",
      enabled: true,
      definition: { steps: [{ name: "do_thing" }] },
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
    });
    deps.getRun = async () => ({
      id: "run_test",
      title: "Test Run",
      status: "executing",
      mode: "agent",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
      input: {},
      context: {},
    });

    const executor = new WorkflowToolExecutor(deps);
    const result = await executor.execute(createInput());

    // Step created
    expect(steps).toEqual([
      expect.objectContaining({
        id: "tc_test",
        runId: "run_test",
        type: "skill",
        name: "Test Workflow",
        status: "running",
        skillId: "workflow.wf_test",
      }),
    ]);

    // Step completed with result output
    const stepStatus = stepStatuses.get("tc_test");
    expect(stepStatus).toEqual({
      status: "completed",
      output: expect.objectContaining({
        status: "completed",
        summary: "Workflow Test Workflow executed.",
        content: expect.stringContaining("Test Workflow"),
        artifacts: [],
      }),
      error: undefined,
    });

    // Result
    expect(result).toEqual({
      status: "completed",
      summary: "Workflow Test Workflow executed.",
      content: expect.stringContaining("Test Workflow"),
      artifacts: [],
    });
  });

  // ── thrown error → step failed ──────────────────────────────────
  test("creates step and fails when execution throws an error", async () => {
    const { deps, steps, stepStatuses } = createDeps();
    deps.findWorkflow = async () => ({
      id: "wf_test",
      title: "Error Workflow",
      version: "1.0.0",
      source: "builtin",
      enabled: true,
      definition: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
    });
    deps.getRun = async () => {
      throw new Error("Database connection lost");
    };

    const executor = new WorkflowToolExecutor(deps);
    const result = await executor.execute(createInput());

    // Step created before the error
    expect(steps).toEqual([
      expect.objectContaining({
        id: "tc_test",
        name: "Error Workflow",
        status: "running",
      }),
    ]);

    // Step marked as failed with the thrown error
    expect(stepStatuses.get("tc_test")).toEqual({
      status: "failed",
      output: undefined,
      error: {
        code: "AGENT_WORKFLOW_EXECUTION_FAILED",
        message: "Database connection lost",
      },
    });

    expect(result).toEqual({
      status: "failed",
      summary: "Database connection lost",
      artifacts: [],
      error: {
        code: "AGENT_WORKFLOW_EXECUTION_FAILED",
        message: "Database connection lost",
      },
    });
  });

  // ── non-Error thrown → step failed with stringified message ─────
  test("handles non-Error throws by stringifying the rejection", async () => {
    const { deps, steps, stepStatuses } = createDeps();
    deps.findWorkflow = async () => ({
      id: "wf_test",
      title: "Bad Workflow",
      version: "1.0.0",
      source: "builtin",
      enabled: true,
      definition: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
    });
    deps.getRun = async () => {
      throw "something went sideways";
    };

    const executor = new WorkflowToolExecutor(deps);
    const result = await executor.execute(createInput());

    expect(steps).toEqual([
      expect.objectContaining({
        id: "tc_test",
        status: "running",
      }),
    ]);

    expect(stepStatuses.get("tc_test")).toEqual({
      status: "failed",
      output: undefined,
      error: {
        code: "AGENT_WORKFLOW_EXECUTION_FAILED",
        message: "something went sideways",
      },
    });

    expect(result).toEqual({
      status: "failed",
      summary: "something went sideways",
      artifacts: [],
      error: {
        code: "AGENT_WORKFLOW_EXECUTION_FAILED",
        message: "something went sideways",
      },
    });
  });

  // ── signal aborted during execution → cancelled ─────────────────
  test("cancels when signal aborts during execution", async () => {
    const { deps, steps, stepStatuses } = createDeps();
    const abortController = new AbortController();

    deps.findWorkflow = async () => ({
      id: "wf_test",
      title: "Slow Workflow",
      version: "1.0.0",
      source: "builtin",
      enabled: true,
      definition: {},
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:01.000Z",
    });
    deps.getRun = async () => {
      // Simulate mid-execution abort
      abortController.abort();
      return {
        id: "run_test",
        title: "Test Run",
        status: "executing",
        mode: "agent",
        createdAt: "2026-06-06T00:00:00.000Z",
        updatedAt: "2026-06-06T00:00:01.000Z",
        input: {},
        context: {},
      };
    };

    const executor = new WorkflowToolExecutor(deps);
    const result = await executor.execute(
      createInput({ signal: abortController.signal }),
    );

    expect(steps).toEqual([
      expect.objectContaining({
        id: "tc_test",
        status: "running",
      }),
    ]);

    // Step cancelled due to mid-execution abort
    expect(stepStatuses.get("tc_test")).toEqual({
      status: "cancelled",
      output: undefined,
      error: {
        code: "AGENT_RUN_CANCELLED",
        message: "Workflow cancelled during execution.",
      },
    });

    expect(result).toEqual({
      status: "cancelled",
      summary: "Workflow cancelled during execution.",
      artifacts: [],
      error: {
        code: "AGENT_RUN_CANCELLED",
        message: "Workflow cancelled.",
      },
    });
  });
});
