import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { DefaultMemoryWriter } from "./memory-writer.js";
import type { AgentContext, AgentLoopInput, RoutedIntent } from "../loop-types.js";

const loopInput: AgentLoopInput = {
  runId: "run_1",
  conversationId: "conversation_1",
  userMessageId: "message_1",
  userId: "user_1",
  message: "remember: I prefer concise Chinese answers",
  mode: "chat",
  client: { source: "web" },
};

const context: AgentContext = {
  runId: loopInput.runId,
  conversationId: loopInput.conversationId,
  userId: loopInput.userId,
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: { id: loopInput.userMessageId, content: loopInput.message, attachments: [] },
  messages: [],
  memories: [],
  artifacts: [],
  toolResults: [],
  availableSkills: [],
  limits: { maxTokens: 1000, reservedForOutput: 100, usedTokensEstimate: 10 },
  tokenEstimate: 10,
};

const intent: RoutedIntent = {
  type: "casual_chat",
  confidence: 0.8,
  requiresPlanning: false,
  requiresTool: false,
  requiresApproval: false,
  riskLevel: "low",
  candidateSkills: [],
  reason: "test",
};

describe("DefaultMemoryWriter", () => {
  test("writes explicit user memory with scope isolation fields", async () => {
    const db = new InMemoryDatabaseContext();
    const writer = new DefaultMemoryWriter({
      repository: db.memory,
      idGenerator: () => "memory_1",
      clock: () => new Date("2026-06-06T00:00:00.000Z"),
    });

    const result = await writer.writeFromTurn({ input: loopInput, context, intent, responseMessageId: "msg_assistant" });

    expect(result.written).toEqual([
      expect.objectContaining({
        id: "memory_1",
        scope: "user",
        scopeId: "user_1",
        type: "user_preference",
        source: "user_explicit",
      }),
    ]);
    expect(await db.memory.search({ query: "concise", userId: "user_1" })).toHaveLength(1);
    expect(await db.memory.search({ query: "concise", userId: "user_2" })).toHaveLength(0);
  });

  test("rejects secret-like memory candidates", async () => {
    const db = new InMemoryDatabaseContext();
    const writer = new DefaultMemoryWriter({ repository: db.memory });

    const result = await writer.writeFromTurn({
      input: { ...loopInput, message: "remember: api_key=sk-abcdefghijklmnopqrstuvwxyz123456" },
      context,
      intent,
    });

    expect(result.written).toHaveLength(0);
    expect(result.rejected[0]?.reason).toContain("secret-like");
  });

  test("supersedes similar scoped memory", async () => {
    const db = new InMemoryDatabaseContext();
    await db.memory.create({
      id: "memory_old",
      key: "user_preference:i-prefer-concise-chinese-answers",
      value: "I prefer concise Chinese answers",
      scope: "user",
      scopeId: "user_1",
      type: "user_preference",
      title: "I prefer concise Chinese answers",
      content: "I prefer concise Chinese answers",
      source: "user_explicit",
      confidence: 0.8,
      importance: 0.6,
      metadata: {},
      createdAt: "2026-06-05T00:00:00.000Z",
    });
    const writer = new DefaultMemoryWriter({
      repository: db.memory,
      idGenerator: () => "memory_new",
      clock: () => new Date("2026-06-06T00:00:00.000Z"),
    });

    const result = await writer.writeFromTurn({ input: loopInput, context, intent });

    expect(result.superseded).toEqual([{ oldMemoryId: "memory_old", newMemoryId: "memory_new" }]);
    expect((await db.memory.search({ query: "concise", userId: "user_1" })).map((memory) => memory.id)).toEqual(["memory_new"]);
  });
});
