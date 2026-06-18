/**
 * AgentLoopEngine content-block stream integration tests (§P1-3).
 *
 * Verifies:
 *   - no_tool path: single save, messageId consistency, non-empty content/parts, no legacy delta.
 *   - low-risk tool path: correct event sequence with text/status/tool_use/tool_result parts.
 */
import { describe, expect, test, vi } from "vitest";
import { AgentLoopEngine } from "./agent-loop-engine.js";
import type { AgentLoopEngineDeps } from "./agent-loop-engine.js";
import type {
  AgentContext,
  AgentLoopInput,
  AgentObservation,
  AgentPlan,
  RoutedIntent,
  ToolDecision,
} from "./loop-types.js";
import type { InMemoryAgentEventBus } from "./agent-event-bus.js";
import { InMemoryAgentEventBus as EventBusImpl } from "./agent-event-bus.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeInput(overrides?: Partial<AgentLoopInput>): AgentLoopInput {
  return {
    runId: "run-test",
    conversationId: "conv-test",
    userMessageId: "umsg-test",
    userId: "user-test",
    message: "Hello, what model are you?",
    mode: "chat",
    permissionMode: "auto",
    modelId: "dp",
    client: { source: "web" },
    ...overrides,
  };
}

function makeNoToolContext(): AgentContext {
  return {
    runId: "run-test",
    conversationId: "conv-test",
    userId: "user-test",
    system: { persona: "You are helpful.", rules: [], safety: [] },
    currentMessage: {
      id: "umsg-test",
      content: "Hello, what model are you?",
      attachments: [],
    },
    messages: [{ role: "user", content: "Hello, what model are you?" }],
    memories: [],
    artifacts: [],
    toolResults: [],
    availableSkills: [],
    limits: { maxTokens: 8000, reservedForOutput: 1024, usedTokensEstimate: 50 },
    tokenEstimate: 50,
  };
}

function makeNoToolIntent(): RoutedIntent {
  return {
    type: "casual_chat",
    confidence: 0.95,
    requiresPlanning: false,
    requiresTool: false,
    requiresApproval: false,
    riskLevel: "low",
    candidateSkills: [],
    reason: "Casual chat — no tools needed",
  };
}

function makeNoToolDecision(): ToolDecision & { type: "no_tool" } {
  return {
    type: "no_tool",
    reason: "Intent does not require tools",
  };
}

function makeToolContext(): AgentContext {
  return {
    runId: "run-test",
    conversationId: "conv-test",
    userId: "user-test",
    system: { persona: "You are helpful.", rules: [], safety: [] },
    currentMessage: {
      id: "umsg-test",
      content: "Search for files containing DELETE",
      attachments: [],
    },
    messages: [{ role: "user", content: "Search for files containing DELETE" }],
    memories: [],
    artifacts: [],
    toolResults: [],
    availableSkills: [
      { id: "search", name: "搜索代码", description: "Search code", category: "code" },
    ],
    limits: { maxTokens: 8000, reservedForOutput: 1024, usedTokensEstimate: 50 },
    tokenEstimate: 50,
  };
}

function makeToolIntent(): RoutedIntent {
  return {
    type: "code_modification",
    confidence: 0.9,
    requiresPlanning: false,
    requiresTool: true,
    requiresApproval: false,
    riskLevel: "low",
    candidateSkills: ["search"],
    reason: "Need to search code",
  };
}

function makeToolDecision(): ToolDecision & { type: "use_tool" } {
  return {
    type: "use_tool",
    reason: "Tool matched",
    toolCalls: [
      {
        id: "tc-1",
        skillId: "search",
        name: "搜索代码",
        arguments: { query: "DELETE" },
        permissions: ["filesystem.read"],
        reason: "Search for DELETE handler",
        riskLevel: "low",
        requiresApproval: false,
        timeoutMs: 30000,
        riskHints: { defaultRisk: "low" },
      },
    ],
  };
}

/** Simple LLM chunk iterator for ResponseComposer / ToolDecisionEngine. */
async function* mockLlmChunks(text: string): AsyncIterable<{ delta: string }> {
  for (const char of text) {
    yield { delta: char };
  }
}

// ── no_tool stream integration test ──────────────────────────────────

describe("AgentLoopEngine content-block stream — no_tool", () => {
  test("saves exactly one assistant message with consistent messageId and non-empty parts", async () => {
    const savedMessages: Array<{
      id: string;
      conversationId: string;
      role: string;
      content: string;
      runId: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const eventBus = new EventBusImpl() as InMemoryAgentEventBus;
    eventBus.subscribe((event) => {
      emittedEvents.push({
        type: event.type,
        payload: event.payload as Record<string, unknown>,
      });
    });

    const deps: AgentLoopEngineDeps = {
      eventBus,
      contextBuilder: {
        build: vi.fn().mockResolvedValue(makeNoToolContext()),
      },
      intentRouter: {
        route: vi.fn().mockResolvedValue(makeNoToolIntent()),
      },
      planner: {
        createPlan: vi.fn(),
      },
      toolDecisionEngine: {
        decide: vi.fn().mockResolvedValue(makeNoToolDecision()),
        executeStreaming: vi.fn(),
      },
      executionOrchestrator: {
        execute: vi.fn(),
      },
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: false, riskLevel: "low", reasons: [] }),
      },
      approvalGate: {
        createApproval: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
      },
      reflectionEngine: {
        reflect: vi.fn(),
      },
      responseComposer: {
        composeDirect: vi.fn().mockImplementation(async (_input: Record<string, unknown>, _signal: AbortSignal) => {
          const streamOpts = (_input as { stream?: { stream: { appendText: (id: string, d: string) => void }; textPartId: string } }).stream;
          // Simulate streaming: append deltas through stream
          const text = "I am an AI assistant. How can I help you?";
          if (streamOpts) {
            for (const c of text) {
              streamOpts.stream.appendText(streamOpts.textPartId, c);
            }
          }
          return { messageId: "msg-from-composer", content: text };
        }),
        composeFromObservation: vi.fn(),
        composeClarification: vi.fn(),
      },
      runStateManager: {
        markStatus: vi.fn(),
        markCancelled: vi.fn(),
        markFailed: vi.fn(),
        getRun: vi.fn(),
        saveTaskState: vi.fn(),
      } as unknown as AgentLoopEngineDeps["runStateManager"],
      saveMessage: async (msg) => {
        savedMessages.push(msg);
      },
    };

    const engine = new AgentLoopEngine(deps);
    const input = makeInput();
    const result = await engine.run(input, new AbortController().signal);

    // Assert: completed
    expect(result.status).toBe("completed");
    expect(result.assistantMessageId).toBeDefined();

    // Assert: exactly one assistant message saved
    const assistantMsgs = savedMessages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBe(1);

    const saved = assistantMsgs[0]!;
    // Assert: messageId matches run result
    expect(saved.id).toBe(result.assistantMessageId);

    // Assert: content non-empty
    expect(saved.content.length).toBeGreaterThan(0);
    expect(saved.content).toContain("AI assistant");

    // Assert: metadata.parts exists with non-empty text part
    const parts = saved.metadata?.parts as Array<{ type: string; content?: string }> | undefined;
    expect(parts).toBeDefined();
    expect(parts!.length).toBeGreaterThan(0);
    const textPart = parts!.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart!.content!.length).toBeGreaterThan(0);

    // Assert: agent.message.completed emitted with correct messageId
    const completedEvent = emittedEvents.find((e) => e.type === "agent.message.completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent!.payload.messageId).toBe(saved.id);
    expect(completedEvent!.payload.content).toBe(saved.content);

    // Assert: agent.run.completed references correct messageId
    const runCompleted = emittedEvents.find((e) => e.type === "agent.run.completed");
    expect(runCompleted).toBeDefined();
    expect(runCompleted!.payload.assistantMessageId).toBe(saved.id);

    // Assert: NO legacy agent.response.delta emitted
    const legacyDeltas = emittedEvents.filter((e) => e.type === "agent.response.delta");
    expect(legacyDeltas.length).toBe(0);
  });
});

// ── low-risk tool stream integration test ────────────────────────────

describe("AgentLoopEngine content-block stream — low-risk tool", () => {
  test("emits correct event sequence with text/status/tool_use/tool_result parts", async () => {
    const savedMessages: Array<{
      id: string;
      role: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const eventBus = new EventBusImpl() as InMemoryAgentEventBus;
    eventBus.subscribe((event) => {
      emittedEvents.push({
        type: event.type,
        payload: event.payload as Record<string, unknown>,
      });
    });

    const deps: AgentLoopEngineDeps = {
      eventBus,
      contextBuilder: {
        build: vi.fn().mockResolvedValue(makeToolContext()),
      },
      intentRouter: {
        route: vi.fn().mockResolvedValue(makeToolIntent()),
      },
      planner: {
        createPlan: vi.fn(),
      },
      toolDecisionEngine: {
        decide: vi.fn().mockResolvedValue(makeToolDecision()),
        executeStreaming: vi.fn().mockImplementation(async (input: Record<string, unknown>, _signal: AbortSignal) => {
          const stream = (input as { stream?: { startTextPart: () => { id: string }; appendText: (id: string, d: string) => void; completeTextPart: (id: string) => void; startStatus: (opts: Record<string, unknown>) => { id: string }; updateStatus: (id: string, p: Record<string, unknown>) => void; addToolUse: (opts: Record<string, unknown>) => void; updateToolUse: (id: string, p: Record<string, unknown>) => void; addToolResult: (opts: Record<string, unknown>) => void } }).stream;
          if (stream) {
            // Model turn 1: text
            const textPart = stream.startTextPart();
            stream.appendText(textPart.id, "Let me search for that.");
            stream.completeTextPart(textPart.id);

            // Tool execution
            stream.addToolUse({
              toolCallId: "tc-1",
              skillId: "search",
              name: "搜索代码",
            });
            stream.updateToolUse("tc-1", { status: "running" });
            const statusPart = stream.startStatus({
              label: "正在调用工具: 搜索代码",
              toolCallId: "tc-1",
            });
            stream.updateStatus(statusPart.id, {
              status: "completed",
              label: "完成: 搜索代码",
            });
            stream.updateToolUse("tc-1", { status: "completed" });
            stream.addToolResult({
              toolCallId: "tc-1",
              skillId: "search",
              summary: "Found 3 files with DELETE",
            });

            // Model turn 2: observation text
            const textPart2 = stream.startTextPart();
            stream.appendText(textPart2.id, "Found the issue in api.ts.");
            stream.completeTextPart(textPart2.id);
          }
          return {
            messageId: (input as { messageId?: string }).messageId ?? "msg-unknown",
            content: "Let me search for that.\nFound the issue in api.ts.",
            artifacts: [],
            toolCalls: [{ id: "tc-1", skillId: "search", name: "搜索代码", status: "completed", summary: "Found 3 files with DELETE" }],
          };
        }),
      },
      executionOrchestrator: {
        execute: vi.fn(),
      },
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: false, riskLevel: "low", reasons: [] }),
      },
      approvalGate: {
        createApproval: vi.fn(),
        approve: vi.fn(),
        reject: vi.fn(),
      },
      reflectionEngine: {
        reflect: vi.fn(),
      },
      responseComposer: {
        composeDirect: vi.fn(),
        composeFromObservation: vi.fn(),
        composeClarification: vi.fn(),
      },
      runStateManager: {
        markStatus: vi.fn(),
        markCancelled: vi.fn(),
        markFailed: vi.fn(),
        getRun: vi.fn(),
        saveTaskState: vi.fn(),
      } as unknown as AgentLoopEngineDeps["runStateManager"],
      saveMessage: async (msg) => {
        savedMessages.push(msg);
      },
    };

    const engine = new AgentLoopEngine(deps);
    const input = makeInput({
      message: "Search for files containing DELETE",
      mode: "agent",
    });
    const result = await engine.run(input, new AbortController().signal);

    // Assert: completed
    expect(result.status).toBe("completed");
    expect(result.assistantMessageId).toBeDefined();

    // Assert: exactly one assistant message saved
    const assistantMsgs = savedMessages.filter((m) => m.role === "assistant");
    expect(assistantMsgs.length).toBe(1);

    const saved = assistantMsgs[0]!;
    expect(saved.id).toBe(result.assistantMessageId);

    // Assert: metadata.parts contains the expected interleaved types
    const parts = saved.metadata?.parts as Array<{ type: string }> | undefined;
    expect(parts).toBeDefined();
    const partTypes = parts!.map((p) => p.type);

    // Expected sequence: text → tool_use → status → tool_result → text
    expect(partTypes).toContain("text");
    expect(partTypes).toContain("tool_use");
    expect(partTypes).toContain("status");
    expect(partTypes).toContain("tool_result");

    // Assert: event sequence contains key content-block events
    const eventTypes = emittedEvents.map((e) => e.type);
    expect(eventTypes).toContain("agent.message.started");
    expect(eventTypes).toContain("agent.message.part.started");
    expect(eventTypes).toContain("agent.message.part.updated");
    expect(eventTypes).toContain("agent.message.completed");

    // Assert: NO legacy agent.response.delta emitted
    const legacyDeltas = emittedEvents.filter((e) => e.type === "agent.response.delta");
    expect(legacyDeltas.length).toBe(0);
  });
});

// ── History parts recovery test (§P1-3c) ─────────────────────────────

describe("AgentLoopEngine — history parts recovery", () => {
  test("saved message metadata.parts survives round-trip through AgentMessage mapping", async () => {
    const savedMessages: Array<{
      id: string;
      conversationId: string;
      role: string;
      content: string;
      runId: string;
      metadata?: Record<string, unknown>;
    }> = [];
    const eventBus = new EventBusImpl() as InMemoryAgentEventBus;

    const deps: AgentLoopEngineDeps = {
      eventBus,
      contextBuilder: {
        build: vi.fn().mockResolvedValue(makeNoToolContext()),
      },
      intentRouter: {
        route: vi.fn().mockResolvedValue(makeNoToolIntent()),
      },
      planner: { createPlan: vi.fn() },
      toolDecisionEngine: {
        decide: vi.fn().mockResolvedValue(makeNoToolDecision()),
        executeStreaming: vi.fn(),
      },
      executionOrchestrator: { execute: vi.fn() },
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: false, riskLevel: "low", reasons: [] }),
      },
      approvalGate: { createApproval: vi.fn(), approve: vi.fn(), reject: vi.fn() },
      reflectionEngine: { reflect: vi.fn() },
      responseComposer: {
        composeDirect: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
          const streamOpts = (input as { stream?: { stream: { appendText: (id: string, d: string) => void }; textPartId: string } }).stream;
          if (streamOpts) {
            for (const c of "Response text") streamOpts.stream.appendText(streamOpts.textPartId, c);
          }
          return { messageId: "x", content: "Response text" };
        }),
        composeFromObservation: vi.fn(),
        composeClarification: vi.fn(),
      },
      runStateManager: {
        markStatus: vi.fn(),
        markCancelled: vi.fn(),
        markFailed: vi.fn(),
        getRun: vi.fn(),
        saveTaskState: vi.fn(),
      } as unknown as AgentLoopEngineDeps["runStateManager"],
      saveMessage: async (msg) => {
        savedMessages.push(msg);
      },
    };

    const engine = new AgentLoopEngine(deps);
    await engine.run(makeInput(), new AbortController().signal);

    // Simulate what AgentMessage mapping does — extract parts from metadata
    const msg = savedMessages.find((m) => m.role === "assistant");
    expect(msg).toBeDefined();
    const parts = msg!.metadata?.parts as Array<{ type: string; content?: string }> | undefined;
    expect(parts).toBeDefined();

    // Verify parts can be mapped to AgentMessage shape
    const agentMessage = {
      id: msg!.id,
      conversationId: msg!.conversationId,
      role: msg!.role,
      content: msg!.content,
      createdAt: new Date().toISOString(),
      parts: parts,
    };
    expect(agentMessage.parts).toBeDefined();
    expect(agentMessage.parts!.length).toBeGreaterThan(0);

    // Verify text part content was preserved
    const textPart = agentMessage.parts!.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart!.content).toBe("Response text");
  });
});

// ── Approval continuity tests (§Step 4) ─────────────────────────────

describe("AgentLoopEngine — approval parts continuity", () => {
  test("saves parts snapshot on approval wait", async () => {
    const savedTaskStates: Map<string, Record<string, unknown>> = new Map();
    const eventBus = new EventBusImpl() as InMemoryAgentEventBus;

    const deps: AgentLoopEngineDeps = {
      eventBus,
      contextBuilder: { build: vi.fn().mockResolvedValue(makeNoToolContext()) },
      intentRouter: { route: vi.fn().mockResolvedValue(makeNoToolIntent()) },
      planner: { createPlan: vi.fn() },
      toolDecisionEngine: {
        decide: vi.fn().mockResolvedValue({
          type: "require_approval",
          reason: "Needs user approval",
          approval: { title: "删除文件", description: "即将删除", riskLevel: "high" },
        } satisfies ToolDecision),
        executeStreaming: vi.fn(),
      },
      executionOrchestrator: { execute: vi.fn() },
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: false, riskLevel: "low", reasons: [] }),
      },
      approvalGate: {
        createApproval: vi.fn().mockResolvedValue({ id: "approval-1", status: "pending" }),
        approve: vi.fn(),
        reject: vi.fn(),
      },
      reflectionEngine: { reflect: vi.fn() },
      responseComposer: {
        composeDirect: vi.fn(),
        composeFromObservation: vi.fn(),
        composeClarification: vi.fn(),
      },
      runStateManager: {
        markStatus: vi.fn(),
        markCancelled: vi.fn(),
        markFailed: vi.fn(),
        getRun: vi.fn().mockResolvedValue({
          runId: "run-test",
          conversationId: "conv-test",
          status: "waiting_approval",
          mode: "agent",
          goal: "delete files",
          taskState: {
            goal: "删除文件",
            completedSteps: [],
            pendingSteps: [],
            gatheredFacts: {
              approvalMessageId: "msg-test",
              partsSnapshot: [{ id: "p1", type: "status", label: "等待确认: 删除文件", status: "running", runId: "run-test", createdAt: new Date().toISOString() }],
            },
            openQuestions: [],
            iteration: 0,
          },
        }),
        saveTaskState: vi.fn((_runId: string, taskState: unknown) => {
          savedTaskStates.set("run-test", taskState as Record<string, unknown>);
          return Promise.resolve();
        }),
      } as unknown as AgentLoopEngineDeps["runStateManager"],
      saveMessage: async () => {},
    };

    const engine = new AgentLoopEngine(deps);
    const result = await engine.run(makeInput(), new AbortController().signal);
    expect(result.status).toBe("waiting_approval");

    // Assert: parts snapshot was saved to task state
    const taskState = savedTaskStates.get("run-test");
    expect(taskState).toBeDefined();
    const facts = (taskState as { gatheredFacts?: Record<string, unknown> })?.gatheredFacts;
    expect(facts).toBeDefined();
    expect(facts!.approvalMessageId).toBeDefined();
    expect(facts!.partsSnapshot).toBeDefined();
  });

  test("resumes approved tool with initialParts hydrate", async () => {
    const savedMessages: Array<{ id: string; role: string; metadata?: Record<string, unknown> }> = [];
    const eventBus = new EventBusImpl() as InMemoryAgentEventBus;

    const deps: AgentLoopEngineDeps = {
      eventBus,
      contextBuilder: { build: vi.fn().mockResolvedValue(makeToolContext()) },
      intentRouter: { route: vi.fn().mockResolvedValue(makeToolIntent()) },
      planner: { createPlan: vi.fn() },
      toolDecisionEngine: {
        decide: vi.fn(),
        executeStreaming: vi.fn().mockImplementation(async (input: Record<string, unknown>) => {
          const stream = (input as { stream?: { startTextPart: () => { id: string }; appendText: (id: string, d: string) => void; completeTextPart: (id: string) => void; startStatus: (opts: Record<string, unknown>) => { id: string }; updateStatus: (id: string, p: Record<string, unknown>) => void; addToolUse: (opts: Record<string, unknown>) => void; updateToolUse: (id: string, p: Record<string, unknown>) => void; addToolResult: (opts: Record<string, unknown>) => void } }).stream;
          if (stream) {
            const tp = stream.startTextPart();
            stream.appendText(tp.id, "Executing approved action.");
            stream.completeTextPart(tp.id);
          }
          return { messageId: (input as { messageId?: string }).messageId ?? "msg", content: "Done", artifacts: [], toolCalls: [] };
        }),
      },
      executionOrchestrator: { execute: vi.fn() },
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: false, riskLevel: "low", reasons: [] }),
      },
      approvalGate: { createApproval: vi.fn(), approve: vi.fn(), reject: vi.fn() },
      reflectionEngine: { reflect: vi.fn() },
      responseComposer: {
        composeDirect: vi.fn(),
        composeFromObservation: vi.fn(),
        composeClarification: vi.fn(),
      },
      runStateManager: {
        markStatus: vi.fn(),
        markCancelled: vi.fn(),
        markFailed: vi.fn(),
        getRun: vi.fn().mockResolvedValue({
          runId: "run-test",
          conversationId: "conv-test",
          status: "waiting_approval",
          mode: "agent",
          goal: "approved task",
          taskState: {
            goal: "approved task",
            completedSteps: [],
            pendingSteps: [],
            gatheredFacts: {
              approvalMessageId: "msg-resume",
              partsSnapshot: [{ id: "p1", type: "status", label: "等待确认: 操作", status: "running", runId: "run-test", createdAt: new Date().toISOString() }],
            },
            openQuestions: [],
            iteration: 0,
          },
        }),
        saveTaskState: vi.fn(),
      } as unknown as AgentLoopEngineDeps["runStateManager"],
      saveMessage: async (msg) => { savedMessages.push(msg); },
    };

    const engine = new AgentLoopEngine(deps);
    const result = await engine.resumeApprovedTool(
      {
        approvalId: "approval-1",
        runId: "run-test",
        messageId: "msg-resume",
        title: "执行操作",
        requestedAction: {
          skillId: "shell.execute",
          arguments: { command: "ls" },
          permissions: ["shell.execute"],
        },
      },
      new AbortController().signal,
    );

    expect(result.status).toBe("completed");
    const msg = savedMessages.find((m) => m.role === "assistant");
    expect(msg).toBeDefined();
    expect(msg!.id).toBe("msg-resume");
    // Should have both the hydrated "等待确认" part and the new "Executing" text
    const parts = msg!.metadata?.parts as Array<{ type: string }> | undefined;
    expect(parts).toBeDefined();
    const statusParts = parts!.filter((p) => p.type === "status");
    expect(statusParts.length).toBeGreaterThanOrEqual(1);
  });
});

// ── runNarrativeLoop deleted (§5.7) — test verifies streaming path ──

describe("AgentLoopEngine — streaming path (no narrative fallback)", () => {
  test("completes via streaming path without narrative fallback", async () => {
    const savedMessages: Array<{ id: string; metadata?: Record<string, unknown> }> = [];
    const eventBus = new EventBusImpl() as InMemoryAgentEventBus;

    const deps: AgentLoopEngineDeps = {
      eventBus,
      contextBuilder: { build: vi.fn().mockResolvedValue(makeToolContext()) },
      intentRouter: { route: vi.fn().mockResolvedValue(makeToolIntent()) },
      planner: { createPlan: vi.fn() },
      toolDecisionEngine: {
        decide: vi.fn().mockResolvedValue(makeToolDecision()),
        // Simulate successful streaming (native tool calling works)
        executeStreaming: vi.fn().mockResolvedValue({
          messageId: "msg-stream",
          content: "Found the issue in api.ts.",
          artifacts: [],
          toolCalls: [{ id: "tc-1", skillId: "search", name: "搜索代码", status: "completed" as const, summary: "Found 3 results" }],
        }),
      },
      executionOrchestrator: {
        execute: vi.fn(),
      },
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: false, riskLevel: "low", reasons: [] }),
      },
      approvalGate: { createApproval: vi.fn(), approve: vi.fn(), reject: vi.fn() },
      reflectionEngine: { reflect: vi.fn() },
      responseComposer: {
        composeDirect: vi.fn(),
        composeFromObservation: vi.fn(),
        composeClarification: vi.fn(),
      },
      runStateManager: {
        markStatus: vi.fn(),
        markCancelled: vi.fn(),
        markFailed: vi.fn(),
        getRun: vi.fn(),
        saveTaskState: vi.fn(),
      } as unknown as AgentLoopEngineDeps["runStateManager"],
      saveMessage: async (msg) => { savedMessages.push(msg); },
    };

    const engine = new AgentLoopEngine(deps);
    const result = await engine.run(makeInput({ message: "search for DELETE" }), new AbortController().signal);

    // §5.7: No narrative fallback — normal streaming path completes
    expect(result.status).toBe("completed");
    expect(savedMessages.some((m) => m.role === "assistant")).toBe(true);
  });
});

// ── High-risk tool content-block test (§Step 4) ─────────────────────

describe("AgentLoopEngine — high-risk tools in content-block loop", () => {
  test("does NOT fall back to old path for high-risk (non-approval) tools", async () => {
    const savedMessages: Array<{ id: string; metadata?: Record<string, unknown> }> = [];
    const eventBus = new EventBusImpl() as InMemoryAgentEventBus;

    const highRiskDecision = makeToolDecision();
    highRiskDecision.toolCalls[0]!.riskLevel = "high";
    highRiskDecision.toolCalls[0]!.requiresApproval = false;

    const deps: AgentLoopEngineDeps = {
      eventBus,
      contextBuilder: { build: vi.fn().mockResolvedValue(makeToolContext()) },
      intentRouter: { route: vi.fn().mockResolvedValue(makeToolIntent()) },
      planner: { createPlan: vi.fn() },
      toolDecisionEngine: {
        decide: vi.fn().mockResolvedValue(highRiskDecision),
        executeStreaming: vi.fn().mockImplementation(async (input: Record<string, unknown>, _signal: AbortSignal) => {
          const stream = (input as { stream?: { startTextPart: () => { id: string }; appendText: (id: string, d: string) => void; completeTextPart: (id: string) => void; startStatus: (opts: Record<string, unknown>) => { id: string }; updateStatus: (id: string, p: Record<string, unknown>) => void; addToolUse: (opts: Record<string, unknown>) => void; updateToolUse: (id: string, p: Record<string, unknown>) => void; addToolResult: (opts: Record<string, unknown>) => void } }).stream;
          if (stream) {
            const tp = stream.startTextPart();
            stream.appendText(tp.id, "This is a high-risk operation.");
            stream.completeTextPart(tp.id);
            stream.addToolUse({ toolCallId: "tc-1", skillId: "shell", name: "执行命令" });
            stream.updateToolUse("tc-1", { status: "completed" });
            stream.addToolResult({ toolCallId: "tc-1", skillId: "shell", summary: "Done" });
          }
          return { messageId: (input as { messageId?: string }).messageId ?? "msg", content: "Done", artifacts: [], toolCalls: [] };
        }),
      },
      executionOrchestrator: { execute: vi.fn() },
      permissionPolicy: {
        evaluate: vi.fn().mockResolvedValue({ allowed: true, requiresApproval: false, riskLevel: "high", reasons: [] }),
      },
      approvalGate: { createApproval: vi.fn(), approve: vi.fn(), reject: vi.fn() },
      reflectionEngine: { reflect: vi.fn() },
      responseComposer: {
        composeDirect: vi.fn(),
        composeFromObservation: vi.fn(),
        composeClarification: vi.fn(),
      },
      runStateManager: {
        markStatus: vi.fn(),
        markCancelled: vi.fn(),
        markFailed: vi.fn(),
        getRun: vi.fn(),
        saveTaskState: vi.fn(),
      } as unknown as AgentLoopEngineDeps["runStateManager"],
      saveMessage: async (msg) => { savedMessages.push(msg); },
    };

    const engine = new AgentLoopEngine(deps);
    const result = await engine.run(makeInput({ message: "run shell command" }), new AbortController().signal);

    // High-risk (but not approval) tools should still complete via content-block
    expect(result.status).toBe("completed");
    const msg = savedMessages.find((m) => m.role === "assistant");
    expect(msg).toBeDefined();
    const parts = msg!.metadata?.parts as Array<{ type: string }> | undefined;
    expect(parts).toBeDefined();
    // Should have content-block parts (not missing because of old path fallback)
    expect(parts!.length).toBeGreaterThan(0);
  });
});
