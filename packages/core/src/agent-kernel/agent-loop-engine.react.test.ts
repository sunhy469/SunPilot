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
    expect(saved).toHaveLength(0);
    await expect(runState.getRun(input.runId)).resolves.toEqual(
      expect.objectContaining({ status: "waiting_user" }),
    );
  });
});

function createEngine(
  runState: InMemoryRunStateManager,
  reactLoopRunner: { run: ReturnType<typeof vi.fn> },
  saved: Array<{ id: string; content: string; metadata?: Record<string, unknown> }> | unknown[],
  approvals: unknown[] = [],
) {
  return new AgentLoopEngine({
    contextBuilder: { async build() { return context; } },
    reactLoopRunner: reactLoopRunner as never,
    executionOrchestrator: {
      async execute() { throw new Error("execution must be owned by the runner"); },
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
