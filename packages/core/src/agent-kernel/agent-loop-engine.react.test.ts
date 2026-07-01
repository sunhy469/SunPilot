import { describe, expect, test, vi } from "vitest";
import { InMemoryAgentEventBus } from "./agent-event-bus.js";
import { AgentLoopEngine } from "./agent-loop-engine.js";
import type {
  AgentContext,
  AgentLoopInput,
  PlannedToolCall,
} from "./loop-types.js";
import type { ReactCheckpoint } from "./react-loop/react-types.js";
import { InMemoryRunStateManager } from "./run-state-manager.js";

const input: AgentLoopInput = {
  runId: "run_engine",
  conversationId: "conv_engine",
  userMessageId: "msg_user",
  message: "hello",
  mode: "agent",
  client: { source: "web" },
};

const context: AgentContext = {
  runId: input.runId,
  conversationId: input.conversationId,
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: { id: input.userMessageId, content: input.message, attachments: [] },
  messages: [],
  memories: [],
  artifacts: [],
  toolResults: [],
  availableSkills: [],
  limits: { maxTokens: 8_000, reservedForOutput: 1_000, usedTokensEstimate: 1 },
  tokenEstimate: 1,
};

describe("AgentLoopEngine ReAct integration", () => {
  test("routes every request through ReactLoopRunner and completes one stream", async () => {
    const runState = new InMemoryRunStateManager();
    const saved: Array<{ id: string; content: string; metadata?: Record<string, unknown> }> = [];
    const reactLoopRunner = {
      run: vi.fn(async ({ stream, messageId }: { stream: { startTextPart(role: "final"): { id: string }; appendText(id: string, value: string): void; completeTextPart(id: string): void }; messageId: string }) => {
        const part = stream.startTextPart("final");
        stream.appendText(part.id, "你好");
        stream.completeTextPart(part.id);
        return {
          type: "completed" as const,
          messageId,
          content: "你好",
          artifacts: [],
          toolCalls: [],
          checkpoint: checkpoint(messageId),
          timing: emptyTiming(),
        };
      }),
    };
    const engine = createEngine(runState, reactLoopRunner, saved);
    await runState.createRun(input);

    const result = await engine.run(input, new AbortController().signal);

    expect(result.status).toBe("completed");
    expect(reactLoopRunner.run).toHaveBeenCalledTimes(1);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.content).toBe("你好");
    await expect(runState.getRun(input.runId)).resolves.toEqual(
      expect.objectContaining({ status: "completed" }),
    );
  });

  test("persists a ReAct approval checkpoint and executes nothing", async () => {
    const runState = new InMemoryRunStateManager();
    const call = plannedCall();
    const reactLoopRunner = {
      run: vi.fn(async ({ messageId }: { messageId: string }) => ({
        type: "waiting_approval" as const,
        messageId,
        calls: [call],
        checkpoint: { ...checkpoint(messageId), pendingToolCalls: [call] },
        timing: emptyTiming(),
      })),
    };
    const approvals: unknown[] = [];
    const engine = createEngine(runState, reactLoopRunner, [], approvals);
    await runState.createRun(input);

    const result = await engine.run(input, new AbortController().signal);

    expect(result.status).toBe("waiting_approval");
    expect(approvals).toHaveLength(1);
    const state = await runState.getRun(input.runId);
    expect(state?.taskState?.gatheredFacts.reactCheckpoint).toEqual(
      expect.objectContaining({ pendingToolCalls: [expect.objectContaining({ id: call.id })] }),
    );
  });

  test("persists waiting_user without completing the assistant message", async () => {
    const runState = new InMemoryRunStateManager();
    const saved: unknown[] = [];
    const reactLoopRunner = {
      run: vi.fn(async ({ messageId }: { messageId: string }) => ({
        type: "waiting_user" as const,
        messageId,
        question: "请补充路径",
        missingFields: ["path"],
        checkpoint: checkpoint(messageId),
        timing: emptyTiming(),
      })),
    };
    const engine = createEngine(runState, reactLoopRunner, saved);
    await runState.createRun(input);

    const result = await engine.run(input, new AbortController().signal);

    expect(result.status).toBe("waiting_user");
    expect(saved).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: "status",
              status: "running",
              label: "等待你补充信息",
            }),
          ]),
        }),
      }),
    ]);
    await expect(runState.getRun(input.runId)).resolves.toEqual(
      expect.objectContaining({ status: "waiting_user" }),
    );
  });

  test("writes memory after a waiting_user continuation completes", async () => {
    const runState = new InMemoryRunStateManager();
    const existing = checkpoint("msg_existing");
    await runState.createRun(input);
    await runState.markStatus(input.runId, "running");
    await runState.saveTaskState(input.runId, {
      goal: "waiting for user",
      completedSteps: [],
      pendingSteps: [],
      gatheredFacts: { reactCheckpoint: existing },
      openQuestions: [],
      iteration: 0,
    });
    await runState.markStatus(input.runId, "waiting_user");

    const reactLoopRunner = {
      run: vi.fn(),
      resumeWithUserInput: vi.fn(async ({ stream }: {
        stream: {
          startTextPart(role: "final"): { id: string };
          appendText(id: string, value: string): void;
          completeTextPart(id: string): void;
        };
      }) => {
        const part = stream.startTextPart("final");
        stream.appendText(part.id, "继续完成");
        stream.completeTextPart(part.id);
        return {
          type: "completed" as const,
          messageId: existing.messageId,
          content: "继续完成",
          artifacts: [],
          toolCalls: [],
          checkpoint: existing,
          timing: emptyTiming(),
        };
      }),
    };
    const writeFromTurn = vi.fn(async () => ({
      written: [],
      rejected: [],
      superseded: [],
    }));
    const engine = createEngine(runState, reactLoopRunner, [], [], {
      memoryWriter: { writeFromTurn },
    });

    const result = await engine.resumeWithUserInput(
      { runId: input.runId, message: "补充信息" },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(writeFromTurn).toHaveBeenCalledWith(expect.objectContaining({
      responseMessageId: existing.messageId,
      turnCompleted: true,
    }));
  });

  test("keeps task-scoped safety state when a continuation suspends again", async () => {
    const runState = new InMemoryRunStateManager();
    const existing = checkpoint("msg_existing");
    await runState.createRun(input);
    await runState.markStatus(input.runId, "running");
    await runState.saveTaskState(input.runId, {
      goal: "waiting for user",
      completedSteps: [],
      pendingSteps: [],
      gatheredFacts: { reactCheckpoint: existing },
      openQuestions: [],
      iteration: 0,
    });
    await runState.markStatus(input.runId, "waiting_user");

    const reactLoopRunner = {
      run: vi.fn(),
      resumeWithUserInput: vi.fn(async () => ({
        type: "waiting_user" as const,
        messageId: existing.messageId,
        question: "还需要一个值",
        missingFields: ["value"],
        checkpoint: existing,
        timing: emptyTiming(),
      })),
    };
    const clearSafetyState = vi.fn();
    const engine = createEngine(runState, reactLoopRunner, [], [], {
      clearSafetyState,
    });

    const result = await engine.resumeWithUserInput(
      { runId: input.runId, message: "第一次补充" },
      new AbortController().signal,
    );

    expect(result.status).toBe("waiting_user");
    expect(clearSafetyState).not.toHaveBeenCalled();
  });

  test("fails the run when continuation context preparation fails", async () => {
    const runState = new InMemoryRunStateManager();
    const existing = checkpoint("msg_existing");
    await runState.createRun(input);
    await runState.markStatus(input.runId, "running");
    await runState.saveTaskState(input.runId, {
      goal: "waiting for user",
      completedSteps: [],
      pendingSteps: [],
      gatheredFacts: { reactCheckpoint: existing },
      openQuestions: [],
      iteration: 0,
    });
    await runState.markStatus(input.runId, "waiting_user");
    const engine = createEngine(runState, {
      run: vi.fn(),
      resumeWithUserInput: vi.fn(),
    }, [], [], {
      contextBuilder: {
        async build() {
          throw Object.assign(new Error("context unavailable"), {
            code: "AGENT_CONTEXT_FAILED",
          });
        },
      },
    });

    const result = await engine.resumeWithUserInput(
      { runId: input.runId, message: "answer" },
      new AbortController().signal,
    );

    expect(result.status).toBe("failed");
    await expect(runState.getRun(input.runId)).resolves.toEqual(
      expect.objectContaining({
        status: "failed",
        error: expect.objectContaining({ code: "AGENT_CONTEXT_FAILED" }),
      }),
    );
  });
});

function createEngine(
  runState: InMemoryRunStateManager,
  reactLoopRunner: {
    run: ReturnType<typeof vi.fn>;
    resumeWithUserInput?: ReturnType<typeof vi.fn>;
  },
  saved: Array<{ id: string; content: string; metadata?: Record<string, unknown> }> | unknown[],
  approvals: unknown[] = [],
  options?: {
    memoryWriter?: {
      writeFromTurn: ReturnType<typeof vi.fn>;
    };
    clearSafetyState?: ReturnType<typeof vi.fn>;
    contextBuilder?: {
      build: () => Promise<AgentContext>;
    };
  },
) {
  return new AgentLoopEngine({
    contextBuilder: options?.contextBuilder ?? { async build() { return context; } },
    reactLoopRunner: reactLoopRunner as never,
    executionOrchestrator: {
      async execute() { throw new Error("execution must be owned by the runner"); },
      clearSafetyState: options?.clearSafetyState,
    },
    approvalGate: {
      async createApproval(value) {
        approvals.push(value);
        return { id: "approval_1", status: "pending" };
      },
      async approve() { throw new Error("unused"); },
      async reject() { throw new Error("unused"); },
    },
    runStateManager: runState,
    eventBus: new InMemoryAgentEventBus(),
    saveMessage: async (message) => {
      saved.push(message);
    },
    memoryWriter: options?.memoryWriter as never,
  });
}

function checkpoint(messageId: string): ReactCheckpoint {
  return {
    version: 1,
    runId: input.runId,
    conversationId: input.conversationId,
    messageId,
    iteration: 0,
    modelCalls: 1,
    transcript: [],
    candidateToolIds: [],
    pendingToolCalls: [],
    artifacts: [],
    toolCallSummaries: [],
    partsSnapshot: [],
    permissionMode: "auto",
    updatedAt: new Date().toISOString(),
  };
}

function plannedCall(): PlannedToolCall {
  return {
    id: "call_approval",
    skillId: "test:delete",
    name: "Delete",
    arguments: { path: "/tmp/a" },
    permissions: ["filesystem.delete"],
    reason: "model action",
    riskLevel: "high",
    requiresApproval: true,
    timeoutMs: 1_000,
  };
}

function emptyTiming() {
  return {
    toolRetrievalMs: 0,
    totalToolExecutionMs: 0,
    firstRoundFirstTokenMs: 0,
    finalRoundFirstTokenMs: 0,
  };
}
