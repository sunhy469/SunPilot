import { describe, expect, test } from "vitest";
import { InMemoryAgentEventBus } from "./agent-event-bus.js";
import { AgentLoopEngine } from "./agent-loop-engine.js";
import { InMemoryRunStateManager } from "./run-state-manager.js";
import type { AgentContext, AgentLoopInput } from "./loop-types.js";

const loopInput: AgentLoopInput = {
  runId: "run_test",
  conversationId: "conv_test",
  userMessageId: "msg_user",
  message: "delete a file",
  mode: "agent",
  client: { source: "web" },
};

const context: AgentContext = {
  runId: loopInput.runId,
  conversationId: loopInput.conversationId,
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: {
    id: loopInput.userMessageId,
    content: loopInput.message,
    attachments: [],
  },
  messages: [],
  memories: [],
  artifacts: [],
  toolResults: [],
  availableSkills: [],
  limits: {
    maxTokens: 8_000,
    reservedForOutput: 1_000,
    usedTokensEstimate: 10,
  },
  tokenEstimate: 10,
};

describe("AgentLoopEngine approvals", () => {
  test("does not execute a tool while approval is still pending", async () => {
    let executed = false;
    const evaluatedPermissions: string[][] = [];
    const approvalRiskLevels: string[] = [];
    const runStateManager = new InMemoryRunStateManager();
    const engine = new AgentLoopEngine({
      contextBuilder: {
        async build() {
          return context;
        },
      },
      intentRouter: {
        async route() {
          return {
            type: "file_operation",
            confidence: 0.9,
            requiresPlanning: false,
            requiresTool: true,
            requiresApproval: true,
            riskLevel: "high",
            candidateSkills: ["filesystem.delete"],
            reason: "test",
          };
        },
      },
      planner: {
        async createPlan() {
          throw new Error("planner should not be called");
        },
      },
      toolDecisionEngine: {
        async decide() {
          return {
            type: "use_tool",
            reason: "test",
            toolCalls: [
              {
                id: "tool_1",
                skillId: "filesystem.delete",
                name: "Delete file",
                arguments: { path: "/tmp/example" },
                permissions: ["filesystem.delete"],
                reason: "test",
                riskLevel: "low",
                requiresApproval: true,
                timeoutMs: 1_000,
              },
            ],
          };
        },
      },
      permissionPolicy: {
        async evaluate(input) {
          evaluatedPermissions.push(input.permissions);
          return {
            allowed: true,
            requiresApproval: true,
            riskLevel: "high",
            reasons: ["test"],
          };
        },
      },
      approvalGate: {
        async createApproval(input) {
          approvalRiskLevels.push(input.riskLevel);
          return { id: "approval_1", status: "pending" };
        },
        async approve() {},
        async reject() {},
      },
      executionOrchestrator: {
        async execute() {
          executed = true;
          return {
            runId: loopInput.runId,
            toolCalls: [],
            artifacts: [],
            summary: "",
          };
        },
      },
      reflectionEngine: {
        async reflect() {
          throw new Error("reflection should not be called");
        },
      },
      responseComposer: {
        async composeDirect() {
          throw new Error("response should not be composed");
        },
        async composeFromObservation() {
          throw new Error("response should not be composed");
        },
        async composeClarification() {
          throw new Error("clarification should not be composed");
        },
      },
      runStateManager,
      eventBus: new InMemoryAgentEventBus(),
    });

    await runStateManager.createRun(loopInput);
    const result = await engine.run(loopInput, new AbortController().signal);

    expect(result.status).toBe("waiting_approval");
    expect(executed).toBe(false);
    expect(evaluatedPermissions).toEqual([["filesystem.delete"]]);
    expect(approvalRiskLevels).toEqual(["high"]);
    await expect(runStateManager.getRun(loopInput.runId)).resolves.toEqual(
      expect.objectContaining({ status: "waiting_approval" }),
    );
  });
});

describe("AgentLoopEngine clarification", () => {
  test("persists a clarification response and completes the run", async () => {
    const eventBus = new InMemoryAgentEventBus();
    const events: string[] = [];
    eventBus.subscribe((event) => events.push(event.type));
    const runStateManager = new InMemoryRunStateManager();
    const clarificationCalls: unknown[] = [];
    const engine = new AgentLoopEngine({
      contextBuilder: {
        async build() {
          return context;
        },
      },
      intentRouter: {
        async route() {
          return {
            type: "file_operation",
            confidence: 0.6,
            requiresPlanning: false,
            requiresTool: true,
            requiresApproval: false,
            riskLevel: "medium",
            candidateSkills: ["filesystem.write"],
            reason: "ambiguous target",
          };
        },
      },
      planner: {
        async createPlan() {
          throw new Error("planner should not be called");
        },
      },
      toolDecisionEngine: {
        async decide() {
          return {
            type: "ask_clarification",
            question: "Which file should I update?",
            reason: "Missing target path",
          };
        },
      },
      permissionPolicy: {
        async evaluate() {
          throw new Error("permission should not be evaluated");
        },
      },
      approvalGate: {
        async createApproval() {
          throw new Error("approval should not be created");
        },
        async approve() {},
        async reject() {},
      },
      executionOrchestrator: {
        async execute() {
          throw new Error("tool should not execute");
        },
      },
      reflectionEngine: {
        async reflect() {
          throw new Error("reflection should not run");
        },
      },
      responseComposer: {
        async composeDirect() {
          throw new Error("direct response should not be composed");
        },
        async composeFromObservation() {
          throw new Error("observation response should not be composed");
        },
        async composeClarification(input) {
          clarificationCalls.push(input);
          return {
            messageId: "msg_clarify",
            content: input.question,
          };
        },
      },
      runStateManager,
      eventBus,
    });

    await runStateManager.createRun(loopInput);
    const result = await engine.run(loopInput, new AbortController().signal);

    expect(result).toEqual(
      expect.objectContaining({
        status: "completed",
        assistantMessageId: "msg_clarify",
      }),
    );
    expect(result.error).toBeUndefined();
    expect(clarificationCalls).toEqual([
      expect.objectContaining({
        question: "Which file should I update?",
        reason: "Missing target path",
      }),
    ]);
    expect(events).toContain("agent.response.completed");
    expect(events).toContain("agent.run.completed");
    await expect(runStateManager.getRun(loopInput.runId)).resolves.toEqual(
      expect.objectContaining({ status: "completed" }),
    );
  });
});

describe("AgentLoopEngine memory writing", () => {
  test("writes long-term memory after a completed direct response", async () => {
    const eventBus = new InMemoryAgentEventBus();
    const events: string[] = [];
    eventBus.subscribe((event) => events.push(event.type));
    const runStateManager = new InMemoryRunStateManager();
    const memoryInputs: unknown[] = [];
    const memoryContext: AgentContext = {
      ...context,
      currentMessage: {
        ...context.currentMessage,
        content: "remember: I prefer concise answers",
      },
    };
    const memoryLoopInput: AgentLoopInput = {
      ...loopInput,
      message: "remember: I prefer concise answers",
      userId: "user_1",
      mode: "chat",
    };
    const engine = new AgentLoopEngine({
      contextBuilder: {
        async build() {
          return memoryContext;
        },
      },
      intentRouter: {
        async route() {
          return {
            type: "casual_chat",
            confidence: 0.9,
            requiresPlanning: false,
            requiresTool: false,
            requiresApproval: false,
            riskLevel: "low",
            candidateSkills: [],
            reason: "test",
          };
        },
      },
      planner: {
        async createPlan() {
          throw new Error("planner should not be called");
        },
      },
      toolDecisionEngine: {
        async decide() {
          return { type: "no_tool", reason: "test" };
        },
      },
      permissionPolicy: {
        async evaluate() {
          throw new Error("permission should not be evaluated");
        },
      },
      approvalGate: {
        async createApproval() {
          throw new Error("approval should not be created");
        },
        async approve() {},
        async reject() {},
      },
      executionOrchestrator: {
        async execute() {
          throw new Error("tool should not execute");
        },
      },
      reflectionEngine: {
        async reflect() {
          throw new Error("reflection should not run");
        },
      },
      responseComposer: {
        async composeDirect() {
          return { messageId: "msg_assistant", content: "记住了。" };
        },
        async composeFromObservation() {
          throw new Error("observation response should not be composed");
        },
        async composeClarification() {
          throw new Error("clarification should not be composed");
        },
      },
      runStateManager,
      eventBus,
      memoryWriter: {
        async writeFromTurn(input) {
          memoryInputs.push(input);
          return {
            written: [
              {
                id: "memory_1",
                runId: input.input.runId,
                key: "user_preference:concise",
                value: "I prefer concise answers",
                scope: "user",
                scopeId: "user_1",
                type: "user_preference",
                title: "I prefer concise answers",
                content: "I prefer concise answers",
                source: "user_explicit",
                metadata: {},
                createdAt: "2026-06-06T00:00:00.000Z",
              },
            ],
            rejected: [],
            superseded: [],
          };
        },
      },
    });

    await runStateManager.createRun(memoryLoopInput);
    const result = await engine.run(
      memoryLoopInput,
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    expect(memoryInputs).toHaveLength(1);
    expect(events).toContain("agent.memory.written");
  });
});
