import { describe, expect, test } from "vitest";
import { ContextBuilder } from "./context-builder.js";
import type { AgentLoopInput } from "../loop-types.js";

const input: AgentLoopInput = {
  runId: "run_1",
  conversationId: "conversation_1",
  userMessageId: "message_1",
  userId: "user_1",
  message: "remember deployment",
  mode: "chat",
  client: { source: "web" },
};

describe("ContextBuilder", () => {
  test("passes scope-aware input to memory search and includes retrieved metadata", async () => {
    const calls: unknown[] = [];
    const builder = new ContextBuilder({
      listMessages: async () => [],
      searchMemories: async (searchInput) => {
        calls.push(searchInput);
        return [
          {
            id: "memory_1",
            type: "deployment_info",
            title: "Deployment",
            content: "Use docker compose for local services",
            source: "manual",
            confidence: 0.9,
            scope: "user",
            scopeId: "user_1",
            score: 1.2,
          },
        ];
      },
      listSkills: async () => [],
      maxContextTokens: 2000,
      reservedOutputTokens: 200,
    });

    const context = await builder.build(input, new AbortController().signal);

    // ContextBuilder now searches for conversation_summary memories first
    // to compress older history, then does the main memory search.
    expect(calls).toEqual([
      {
        query: "",
        runId: "run_1",
        conversationId: "conversation_1",
        userId: "user_1",
        limit: 10,
        types: ["conversation_summary"],
        scopes: ["conversation"],
      },
      {
        query: "remember deployment",
        runId: "run_1",
        conversationId: "conversation_1",
        userId: "user_1",
        limit: 10,
      },
    ]);
    expect(context.memories).toEqual([
      expect.objectContaining({
        id: "memory_1",
        type: "deployment_info",
        title: "Deployment",
        source: "manual",
        confidence: 0.9,
      }),
    ]);
  });

  test("returns structured available skills from the skill catalog", async () => {
    const builder = new ContextBuilder({
      listMessages: async () => [],
      listSkills: async () => [
        {
          id: "sunpilot.automation:daily-report.generate",
          name: "Daily Report",
          description: "Create the daily operations report",
          category: "automation",
        },
        {
          id: "test.artifact:artifact.write",
          name: "Write Artifact",
          description: "Create a file artifact",
          category: "artifact",
        },
      ],
      maxContextTokens: 2000,
      reservedOutputTokens: 200,
    });

    const context = await builder.build(input, new AbortController().signal);

    expect(context.availableSkills).toEqual([
      {
        id: "sunpilot.automation:daily-report.generate",
        name: "Daily Report",
        description: "Create the daily operations report",
        category: "automation",
      },
      {
        id: "test.artifact:artifact.write",
        name: "Write Artifact",
        description: "Create a file artifact",
        category: "artifact",
      },
    ]);
  });

  test("includes artifact summaries and recent tool results", async () => {
    const builder = new ContextBuilder({
      listMessages: async () => [],
      listArtifacts: async (runId) => [
        {
          id: "artifact_1",
          name: "report.md",
          type: "markdown",
          summary: `Report for ${runId}`,
        },
      ],
      listToolResults: async () => [
        {
          toolCallId: "tool_1",
          name: "Read File",
          skillId: "filesystem.read",
          status: "completed",
          summary: "Read package.json",
          content: '{"name":"sunpilot"}',
        },
      ],
      maxContextTokens: 2000,
      reservedOutputTokens: 200,
    });

    const context = await builder.build(input, new AbortController().signal);

    expect(context.artifacts).toEqual([
      {
        id: "artifact_1",
        name: "report.md",
        type: "markdown",
        summary: "Report for run_1",
      },
    ]);
    expect(context.toolResults).toEqual([
      {
        toolCallId: "tool_1",
        summary: "Read package.json",
        content: '{"name":"sunpilot"}',
        status: "completed",
      },
    ]);
  });

  // ── P0 golden tests (§context eval) ────────────────────────────

  test("scenario 1 — long-conversation compression: summary replaces covered messages", async () => {
    // 200 messages + 1 summary covering messages 1–199 → only the
    // last (uncovered) raw message should appear in history.
    const msgs = Array.from({ length: 200 }, (_, i) => ({
      id: `msg_${i + 1}`,
      role: (i % 2 === 0 ? "user" : "assistant") as string,
      content: `Message ${i + 1} content here.`,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    }));

    const builder = new ContextBuilder({
      listMessages: async () => msgs,
      searchMemories: async () => [
        {
          id: "summary_1",
          type: "conversation_summary",
          title: "Early conversation",
          content: "User asked about deployment config. Agent suggested docker compose.",
          source: "summary",
          confidence: 0.9,
          score: 0.95,
          metadata: {
            messageRange: { fromMessageId: "msg_1", toMessageId: "msg_199" },
          },
        },
      ],
      maxContextTokens: 200_000,
      reservedOutputTokens: 16_000,
    });

    const ctx = await builder.build(input, new AbortController().signal);
    const historyMsgs = ctx.messages.filter(
      (m) => !m.metadata?.memoryId, // exclude summary entries
    );

    // Only msg_200 should remain in raw history (msg_1..199 covered by summary)
    expect(historyMsgs.length).toBe(1);
    expect(historyMsgs[0]!.content).toBe("Message 200 content here.");
  });

  test("scenario 2 — user correction: stale detection marks goal-change summary", async () => {
    const { SummaryStaleDetector } = await import("./summary-stale-detector.js");
    const staleDetector = new SummaryStaleDetector();

    const builder = new ContextBuilder({
      listMessages: async () => [
        {
          id: "msg_1",
          role: "user",
          content: "I want to use React for the frontend.",
          createdAt: new Date(Date.now() - 2000).toISOString(),
        },
        {
          id: "msg_2",
          role: "assistant",
          content: "Got it, setting up React.",
          createdAt: new Date(Date.now() - 1000).toISOString(),
        },
        {
          id: "msg_3",
          role: "user",
          content: "Actually, let's use Vue instead. I changed my mind.",
          createdAt: new Date().toISOString(),
        },
      ],
      searchMemories: async () => [
        {
          id: "summary_1",
          type: "conversation_summary",
          title: "Tech stack decision",
          content: "User decided to use React for the frontend.",
          source: "summary",
          confidence: 0.9,
          score: 0.9,
          metadata: {
            messageRange: { fromMessageId: "msg_1", toMessageId: "msg_2" },
            createdAt: new Date(Date.now() - 1500).toISOString(),
          },
        },
      ],
      staleDetector,
      maxContextTokens: 200_000,
      reservedOutputTokens: 16_000,
    });

    const ctx = await builder.build(input, new AbortController().signal);
    const summaryMsg = ctx.messages.find(
      (m) => m.metadata?.type === "conversation_summary",
    );

    // Summary should still be present (not dropped) but marked stale
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain("CRITICALLY OUTDATED");
  });

  test("scenario 3 — external injection: attachment metadata preserved in currentMessage", async () => {
    const builder = new ContextBuilder({
      listMessages: async () => [],
      maxContextTokens: 200_000,
      reservedOutputTokens: 16_000,
    });

    const ctx = await builder.build(
      {
        ...input,
        message: "Check this file",
        attachments: [
          {
            id: "att_1",
            name: "malicious.txt",
            type: "text/plain",
            url: "https://evil.example.com/payload",
          },
        ],
      },
      new AbortController().signal,
    );

    // External chunk was removed from ContextBuilder (it consumed budget
    // but wasn't mapped into model input). Attachment metadata is now
    // carried entirely through currentMessage.attachments and the
    // [EXTERNAL] warning is added by ResponseComposer.appendAttachmentLines.
    expect(ctx.currentMessage.attachments).toHaveLength(1);
    expect(ctx.currentMessage.attachments[0]!.name).toBe("malicious.txt");
    expect(ctx.currentMessage.attachments[0]!.url).toBe("https://evil.example.com/payload");

    // No "external" source chunk should be in the snapshot
    const snapshot = ctx.contextSnapshot!;
    const externalChunk = snapshot.chunks.find(
      (c) => c.source === "external",
    );
    expect(externalChunk).toBeUndefined();
  });

  test("scenario 4 — budget trimming: low-priority chunks dropped before mandatory", async () => {
    // Use a very tight budget so optional chunks are trimmed
    const builder = new ContextBuilder({
      listMessages: async () =>
        Array.from({ length: 50 }, (_, i) => ({
          id: `msg_${i}`,
          role: "user" as const,
          content: `Very long message number ${i} with lots of padding text to consume tokens quickly. `.repeat(10),
          createdAt: new Date(Date.now() + i * 1000).toISOString(),
        })),
      searchMemories: async () => [
        {
          id: "mem_1",
          type: "preference",
          title: "User likes dark mode",
          content: "The user prefers dark mode for all interfaces. ".repeat(5),
          source: "inferred",
          confidence: 0.7,
          score: 0.5,
        },
      ],
      listSkills: async () => [
        {
          id: "skill:a",
          name: "Skill A",
          description: "A useful skill for doing things with files and shell commands.",
          category: "automation",
        },
      ],
      listArtifacts: async () => [
        {
          id: "art_1",
          name: "big-artifact.txt",
          type: "text",
          summary: "A very large artifact summary. ".repeat(20),
        },
      ],
      // Very small budget — only mandatory chunks should survive
      maxContextTokens: 500,
      reservedOutputTokens: 0,
    });

    const ctx = await builder.build(input, new AbortController().signal);
    const snapshot = ctx.contextSnapshot!;

    // Mandatory chunks (system, current_message, safety_policy, run_state) must survive
    const mandatory = snapshot.chunks.filter(
      (c) => c.included && ["system", "current_message", "safety_policy", "run_state"].includes(c.source),
    );
    expect(mandatory.length).toBeGreaterThanOrEqual(3);

    // Low-priority chunks (artifact P25, skill_catalog P20) should be trimmed
    const trimmed = snapshot.chunks.filter((c) => !c.included);
    expect(trimmed.length).toBeGreaterThan(0);
  });

  test("scenario 5 — scope isolation: memory search passes conversationId for scoped recall", async () => {
    const searchCalls: Array<{ conversationId?: string }> = [];
    const builder = new ContextBuilder({
      listMessages: async () => [],
      searchMemories: async (searchInput) => {
        searchCalls.push(searchInput);
        return [];
      },
      maxContextTokens: 200_000,
      reservedOutputTokens: 16_000,
    });

    await builder.build(
      {
        ...input,
        conversationId: "conversation_alpha",
        userId: "user_1",
      },
      new AbortController().signal,
    );

    // Every searchMemories call must carry the correct conversation scope
    for (const call of searchCalls) {
      expect(call.conversationId).toBe("conversation_alpha");
    }
  });

  test("scenario 6 — stale summary: priority raised to near-trim when stale", async () => {
    const { SummaryStaleDetector } = await import("./summary-stale-detector.js");
    const staleDetector = new SummaryStaleDetector();

    const builder = new ContextBuilder({
      listMessages: async () => [
        {
          id: "msg_1",
          role: "user",
          content: "Help me search for restaurants.",
          createdAt: new Date(Date.now() - 2000).toISOString(),
        },
        {
          id: "msg_2",
          role: "assistant",
          content: "Here are some restaurants near you.",
          createdAt: new Date(Date.now() - 1000).toISOString(),
        },
        {
          id: "msg_3",
          role: "user",
          content: "Actually, I don't want restaurants anymore. Let's search for hotels instead.",
          createdAt: new Date().toISOString(),
        },
      ],
      searchMemories: async () => [
        {
          id: "summary_old",
          type: "conversation_summary",
          title: "Restaurant search",
          content: "User was searching for restaurants near their location.",
          source: "summary",
          confidence: 0.85,
          score: 0.85,
          metadata: {
            messageRange: { fromMessageId: "msg_1", toMessageId: "msg_2" },
          },
        },
      ],
      staleDetector,
      maxContextTokens: 200_000,
      reservedOutputTokens: 16_000,
    });

    const ctx = await builder.build(input, new AbortController().signal);
    const snapshot = ctx.contextSnapshot!;
    const summaryChunk = snapshot.chunks.find(
      (c) => c.source === "conversation_summary",
    );

    expect(summaryChunk).toBeDefined();
    // Goal-change → critical stale → priority 14 (near trim line)
    expect(summaryChunk!.priority).toBe(14);
    expect(summaryChunk!.warning).toBeDefined();
  });

  test("scenario 7 — current user message participates in stale detection (correction is the ONLY new message)", async () => {
    const { SummaryStaleDetector } = await import("./summary-stale-detector.js");
    const staleDetector = new SummaryStaleDetector();

    // msg_1 + msg_2 are covered by summary. msg_3 IS the current message
    // and carries a goal-change ("Actually...let's search for hotels").
    // Even though it's the current message (matching userMessageId), it
    // MUST still participate in stale detection so the summary gets
    // marked CRITICALLY OUTDATED.
    const builder = new ContextBuilder({
      listMessages: async () => [
        {
          id: "msg_1",
          role: "user",
          content: "Find me good restaurants nearby.",
          createdAt: new Date(Date.now() - 3000).toISOString(),
        },
        {
          id: "msg_2",
          role: "assistant",
          content: "Here are top-rated restaurants in your area.",
          createdAt: new Date(Date.now() - 2000).toISOString(),
        },
      ],
      searchMemories: async () => [
        {
          id: "summary_r",
          type: "conversation_summary",
          title: "Restaurant search",
          content: "User was searching for nearby restaurants.",
          source: "summary",
          confidence: 0.9,
          score: 0.9,
          metadata: {
            messageRange: { fromMessageId: "msg_1", toMessageId: "msg_2" },
          },
        },
      ],
      staleDetector,
      maxContextTokens: 200_000,
      reservedOutputTokens: 16_000,
    });

    const ctx = await builder.build(
      {
        ...input,
        userMessageId: "msg_3",
        message:
          "Actually, I don't want restaurants anymore. Let's search for hotels instead.",
      },
      new AbortController().signal,
    );

    const summaryMsg = ctx.messages.find(
      (m) => m.metadata?.type === "conversation_summary",
    );
    expect(summaryMsg).toBeDefined();
    // Must be marked stale because the current message is a goal-change
    expect(summaryMsg!.content).toContain("CRITICALLY OUTDATED");
  });
});
