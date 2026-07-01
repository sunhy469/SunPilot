/**
 * buildAssistantPresentation.test.ts — pure-function tests for
 * buildThinkingSteps and buildUserFacingBlocks.
 */

import { describe, expect, test } from "vitest";
import {
  buildThinkingSteps,
  buildUserFacingBlocks,
  type ThinkingStep,
  type UserFacingBlock,
} from "./buildAssistantPresentation";
import type {
  AssistantMessagePart,
  AssistantTextPart,
  AssistantStatusPart,
  AssistantToolUsePart,
  AssistantToolResultPart,
  AssistantErrorPart,
} from "../../../features/conversations/types";

// ── Helpers ────────────────────────────────────────────────────────────

function textPart(
  id: string,
  content: string,
  semanticRole?: AssistantTextPart["semanticRole"],
): AssistantTextPart {
  return {
    id,
    type: "text",
    content,
    source: "model",
    status: "completed",
    semanticRole,
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  };
}

function statusPart(
  id: string,
  label: string,
  status: "running" | "completed" | "failed",
  toolCallId?: string,
): AssistantStatusPart {
  return {
    id,
    type: "status",
    label,
    status,
    toolCallId,
    runId: "run_test",
    createdAt: new Date().toISOString(),
  };
}

function toolUsePart(
  id: string,
  toolCallId: string,
  name: string,
  status: "pending" | "running" | "completed" | "failed" | "interrupted" = "completed",
  inputPreview?: Record<string, unknown>,
): AssistantToolUsePart {
  return {
    id,
    type: "tool_use",
    toolCallId,
    skillId: "test:mock",
    name,
    status,
    inputPreview,
    createdAt: new Date().toISOString(),
  };
}

function toolResultPart(
  id: string,
  toolCallId: string,
  summary: string,
  skillId = "test:mock",
): AssistantToolResultPart {
  return {
    id,
    type: "tool_result",
    toolCallId,
    skillId,
    summary,
    trust: "trusted",
    visible: "collapsed",
    createdAt: new Date().toISOString(),
  };
}

function errorPart(
  id: string,
  message: string,
  opts?: {
    recoverable?: boolean;
    scope?: "tool" | "protocol" | "run";
    presentation?: "step_detail" | "fatal";
    toolCallId?: string;
  },
): AssistantErrorPart {
  return {
    id,
    type: "error",
    message,
    code: "TEST",
    recoverable: opts?.recoverable,
    scope: opts?.scope,
    presentation: opts?.presentation,
    toolCallId: opts?.toolCallId,
    createdAt: new Date().toISOString(),
  };
}

// ── buildThinkingSteps ─────────────────────────────────────────────────

describe("buildThinkingSteps", () => {
  test("merges 3–4 parts with the same toolCallId into a single tool step", () => {
    const parts: AssistantMessagePart[] = [
      statusPart("s1", "正在调用工具: search", "running", "call_1"),
      toolUsePart("tu1", "call_1", "search", "running"),
      statusPart("s1", "完成: search", "completed", "call_1"),
      toolResultPart("tr1", "call_1", "找到 5 条结果"),
    ];

    const steps = buildThinkingSteps(parts);
    const toolSteps = steps.filter((s) => s.kind === "tool");
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]!.toolCallId).toBe("call_1");
  });

  test("keeps two calls with different toolCallId as separate steps", () => {
    const parts: AssistantMessagePart[] = [
      toolUsePart("tu1", "call_1", "search", "completed", { query: "a" }),
      toolResultPart("tr1", "call_1", "result A"),
      toolUsePart("tu2", "call_2", "search", "completed", { query: "b" }),
      toolResultPart("tr2", "call_2", "result B"),
    ];

    const steps = buildThinkingSteps(parts);
    const toolSteps = steps.filter((s) => s.kind === "tool");
    expect(toolSteps).toHaveLength(2);
    expect(toolSteps.map((s) => s.toolCallId).sort()).toEqual(
      ["call_1", "call_2"].sort(),
    );
  });

  test("step count reflects logical steps, not part count", () => {
    // 4 parts for one tool call → should produce ~1 step, not 4
    const parts: AssistantMessagePart[] = [
      statusPart("s1", "正在调用工具: search", "running", "call_1"),
      toolUsePart("tu1", "call_1", "search", "running"),
      statusPart("s1", "完成: search", "completed", "call_1"),
      toolResultPart("tr1", "call_1", "找到结果"),
    ];

    const steps = buildThinkingSteps(parts);
    // step count = 1 tool step (no standalone phases since statuses are tool-attached)
    expect(steps.length).toBeLessThan(parts.length);
    expect(steps.length).toBe(1);
  });

  test("handles out-of-order parts (result before status update)", () => {
    const parts: AssistantMessagePart[] = [
      toolResultPart("tr1", "call_1", "result content"),
      toolUsePart("tu1", "call_1", "search", "running"),
      statusPart("s1", "正在调用工具: search", "running", "call_1"),
    ];

    const steps = buildThinkingSteps(parts);
    const toolSteps = steps.filter((s) => s.kind === "tool");
    expect(toolSteps).toHaveLength(1);
    expect(toolSteps[0]!.toolCallId).toBe("call_1");
  });

  test("preserves a failed status that arrives before tool_use", () => {
    const parts: AssistantMessagePart[] = [
      statusPart("s1", "失败: search", "failed", "call_1"),
      toolUsePart("tu1", "call_1", "search", "running"),
    ];

    const steps = buildThinkingSteps(parts);
    expect(steps).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "call_1",
        name: "search",
        status: "failed",
      }),
    ]);
  });

  test("preserves original phase/tool ordering", () => {
    const parts: AssistantMessagePart[] = [
      toolUsePart("tu1", "call_1", "first tool", "completed"),
      statusPart("phase_2", "正在整理结果", "running"),
      toolUsePart("tu2", "call_2", "second tool", "running"),
    ];

    expect(buildThinkingSteps(parts).map((step) => step.key)).toEqual([
      "call_1",
      "phase_2",
      "call_2",
    ]);
  });

  test("keeps completed progress text inside the thinking steps", () => {
    const progress = textPart("progress_1", "先检查可用工具", "progress");

    expect(buildThinkingSteps([progress])).toEqual([
      {
        kind: "narrative",
        key: "progress_1",
        content: "先检查可用工具",
      },
    ]);
  });

  test("does not duplicate an actively streaming progress part in thinking", () => {
    const progress = textPart("progress_1", "正在回答", "progress");
    progress.status = "streaming";
    progress.completedAt = undefined;

    expect(buildThinkingSteps([progress])).toEqual([]);
  });

  test("failed tool step shows failed status from status part", () => {
    const parts: AssistantMessagePart[] = [
      toolUsePart("tu1", "call_1", "search", "running"),
      statusPart("s1", "失败: search", "failed", "call_1"),
      toolResultPart("tr1", "call_1", "服务不可用"),
    ];

    const steps = buildThinkingSteps(parts);
    const toolStep = steps.find((s) => s.kind === "tool") as
      | import("./buildAssistantPresentation").ToolStep
      | undefined;
    expect(toolStep).toBeDefined();
    expect(toolStep!.status).toBe("failed");
  });

  test("interrupted tool_use produces interrupted step", () => {
    const parts: AssistantMessagePart[] = [
      toolUsePart("tu1", "call_1", "search", "interrupted"),
    ];

    const steps = buildThinkingSteps(parts);
    const toolStep = steps.find((s) => s.kind === "tool") as
      | import("./buildAssistantPresentation").ToolStep
      | undefined;
    expect(toolStep).toBeDefined();
    expect(toolStep!.status).toBe("interrupted");
  });

  test("filters out completed '正在分析需求…' and '正在理解需求…' phases", () => {
    const parts: AssistantMessagePart[] = [
      statusPart("s_prep", "正在分析需求…", "completed"),
      toolUsePart("tu1", "call_1", "search", "completed"),
    ];

    const steps = buildThinkingSteps(parts);
    // "正在分析需求…" completed should be filtered out
    const phases = steps.filter(
      (s) => s.kind === "phase" && s.label.includes("分析需求"),
    );
    expect(phases).toHaveLength(0);
  });

  test("step_detail error merged into tool step, not standalone", () => {
    const parts: AssistantMessagePart[] = [
      toolUsePart("tu1", "call_1", "search", "failed"),
      errorPart("e1", "API rate limit exceeded", {
        scope: "tool",
        presentation: "step_detail",
        toolCallId: "call_1",
      }),
    ];

    const steps = buildThinkingSteps(parts);
    const toolStep = steps.find((s) => s.kind === "tool") as
      | import("./buildAssistantPresentation").ToolStep
      | undefined;
    expect(toolStep).toBeDefined();
    expect(toolStep!.status).toBe("failed");
    expect(toolStep!.errorDetail).toContain("API rate limit exceeded");
  });

  test("backward compat: recoverable error without scope merged into tool step", () => {
    const parts: AssistantMessagePart[] = [
      toolUsePart("tu1", "call_1", "search", "failed"),
      errorPart("e1", "Old-style recoverable error", {
        recoverable: true,
        toolCallId: "call_1",
      }),
    ];

    const steps = buildThinkingSteps(parts);
    const toolStep = steps.find((s) => s.kind === "tool") as
      | import("./buildAssistantPresentation").ToolStep
      | undefined;
    expect(toolStep).toBeDefined();
    expect(toolStep!.errorDetail).toContain("Old-style recoverable error");
  });
});

// ── buildUserFacingBlocks ──────────────────────────────────────────────

describe("buildUserFacingBlocks", () => {
  test("final text becomes an answer block", () => {
    const parts: AssistantMessagePart[] = [
      textPart("t1", "这是最终答案", "final"),
    ];

    const blocks = buildUserFacingBlocks(parts);
    const answers = blocks.filter((b) => b.kind === "answer");
    expect(answers).toHaveLength(1);
    expect(answers[0]!.content).toBe("这是最终答案");
  });

  test("user_prompt text becomes a user_prompt block in main area", () => {
    const parts: AssistantMessagePart[] = [
      textPart("t1", "请提供更多信息", "user_prompt"),
    ];

    const blocks = buildUserFacingBlocks(parts);
    const prompts = blocks.filter((b) => b.kind === "user_prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.content).toBe("请提供更多信息");
  });

  test("progress text is excluded from user-facing blocks", () => {
    const parts: AssistantMessagePart[] = [
      textPart("t1", "让我思考一下...", "progress"),
    ];

    const blocks = buildUserFacingBlocks(parts);
    expect(blocks).toHaveLength(0);
  });

  test("active streaming progress is exposed provisionally when requested", () => {
    const part = textPart("t1", "正在流式输出", "progress");
    part.status = "streaming";
    part.completedAt = undefined;

    const blocks = buildUserFacingBlocks([part], {
      includeStreamingProgress: true,
    });

    expect(blocks).toEqual([
      expect.objectContaining({
        kind: "answer",
        content: "正在流式输出",
        partId: "t1",
        provisional: true,
      }),
    ]);
  });

  test("empty streaming progress does not suppress the thinking placeholder", () => {
    const part = textPart("t1", "", "progress");
    part.status = "streaming";
    part.completedAt = undefined;

    expect(
      buildUserFacingBlocks([part], { includeStreamingProgress: true }),
    ).toEqual([]);
  });

  test("fatal error (scope: run) creates a fatal_error block", () => {
    const parts: AssistantMessagePart[] = [
      errorPart("e1", "Run failed", {
        scope: "run",
        presentation: "fatal",
      }),
    ];

    const blocks = buildUserFacingBlocks(parts);
    const fatalErrors = blocks.filter((b) => b.kind === "fatal_error");
    expect(fatalErrors).toHaveLength(1);
    expect(fatalErrors[0]!.message).toBe("Run failed");
  });

  test("step_detail error does not generate a standalone block", () => {
    const parts: AssistantMessagePart[] = [
      errorPart("e1", "Tool error", {
        scope: "tool",
        presentation: "step_detail",
        toolCallId: "call_1",
      }),
    ];

    const blocks = buildUserFacingBlocks(parts);
    expect(blocks).toHaveLength(0);
  });

  test("backward compat: non-recoverable error without scope treated as fatal", () => {
    const parts: AssistantMessagePart[] = [
      errorPart("e1", "Unknown fatal error", {
        recoverable: false,
      }),
    ];

    const blocks = buildUserFacingBlocks(parts);
    const fatalErrors = blocks.filter((b) => b.kind === "fatal_error");
    expect(fatalErrors).toHaveLength(1);
  });

  test("backward compat: recoverable error without scope excluded (step_detail)", () => {
    const parts: AssistantMessagePart[] = [
      errorPart("e1", "Recoverable tool error", {
        recoverable: true,
      }),
    ];

    const blocks = buildUserFacingBlocks(parts);
    // recoverable without scope → treated as step_detail → not shown
    expect(blocks).toHaveLength(0);
  });

  test("mix of final, user_prompt, progress, and fatal error", () => {
    const parts: AssistantMessagePart[] = [
      textPart("t1", "thinking", "progress"),
      textPart("t2", "final answer", "final"),
      textPart("t3", "please provide info", "user_prompt"),
      errorPart("e1", "fatal run error", { scope: "run", presentation: "fatal" }),
      errorPart("e2", "tool error", {
        scope: "tool",
        presentation: "step_detail",
        toolCallId: "c1",
      }),
    ];

    const blocks = buildUserFacingBlocks(parts);
    expect(blocks).toHaveLength(3); // answer + user_prompt + fatal_error
    expect(blocks.some((b) => b.kind === "answer")).toBe(true);
    expect(blocks.some((b) => b.kind === "user_prompt")).toBe(true);
    expect(blocks.some((b) => b.kind === "fatal_error")).toBe(true);
  });

  test("legacy messages without semanticRole produce empty blocks (no crash)", () => {
    const parts: AssistantMessagePart[] = [
      // No semanticRole on text parts
      {
        id: "t1",
        type: "text",
        content: "old content",
        source: "model",
        status: "completed",
        createdAt: new Date().toISOString(),
      } as AssistantTextPart,
    ];

    const blocks = buildUserFacingBlocks(parts);
    // Without semanticRole, no blocks are created (legacy fallback in MessagePartsRenderer handles it)
    expect(blocks).toHaveLength(0);
  });
});
