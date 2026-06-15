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
        query: "conversation_summary",
        runId: "run_1",
        conversationId: "conversation_1",
        userId: "user_1",
        limit: 10,
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
});
