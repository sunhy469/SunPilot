import { describe, it, expect, beforeEach, vi } from "vitest";
import { AssistantMessageStream } from "./assistant-message-stream.js";
import type { AgentEventBus } from "./agent-event-bus.js";
import type { SaveMessageFn } from "./loop-types.js";

function createMockEventBus(): AgentEventBus {
  return {
    emit: vi.fn(),
    publish: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    flush: vi.fn(() => Promise.resolve()),
    subscriberCount: 0,
  };
}

function createMockSaveMessage(): SaveMessageFn {
  return vi.fn(() => Promise.resolve());
}

describe("AssistantMessageStream", () => {
  let eventBus: ReturnType<typeof createMockEventBus>;
  let saveMessage: ReturnType<typeof createMockSaveMessage>;
  let stream: AssistantMessageStream;

  beforeEach(() => {
    eventBus = createMockEventBus();
    saveMessage = createMockSaveMessage();
    stream = new AssistantMessageStream({
      runId: "run-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      eventBus,
      saveMessage: saveMessage as SaveMessageFn,
    });
  });

  // ── Lifecycle ────────────────────────────────────────────────
  it("emits agent.message.started on first start or lazy start", () => {
    stream.start();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "agent.message.started",
      expect.objectContaining({
        runId: "run-1",
        conversationId: "conv-1",
        messageId: "msg-1",
      }),
      expect.anything(),
    );
  });

  it("does not double-emit agent.message.started on second start call", () => {
    stream.start();
    const count = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "agent.message.started",
    ).length;
    stream.start();
    const newCount = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "agent.message.started",
    ).length;
    expect(newCount).toBe(count);
  });

  it("auto-starts when adding parts without explicit start", () => {
    stream.startTextPart();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "agent.message.started",
      expect.anything(),
      expect.anything(),
    );
  });

  // ── Text parts ───────────────────────────────────────────────
  it("startTextPart creates a text part in streaming status", () => {
    const part = stream.startTextPart();
    expect(part.type).toBe("text");
    expect(part.status).toBe("streaming");
    expect(part.content).toBe("");
    expect(part.source).toBe("model");
  });

  it("appendText appends content and emits delta", () => {
    const part = stream.startTextPart();
    stream.appendText(part.id, "Hello ");
    stream.appendText(part.id, "World");

    expect(part.content).toBe("Hello World");
    expect(eventBus.emit).toHaveBeenCalledWith(
      "agent.message.part.delta",
      expect.objectContaining({
        partId: part.id,
        delta: "Hello ",
      }),
      expect.anything(),
    );
  });

  it("appendText never emits legacy agent.response.delta", () => {
    const part = stream.startTextPart();
    stream.appendText(part.id, "test");
    const legacyCalls = (eventBus.emit as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "agent.response.delta",
    );
    expect(legacyCalls.length).toBe(0);
  });

  it("completeTextPart marks text part as completed", () => {
    const part = stream.startTextPart();
    stream.appendText(part.id, "content");
    stream.completeTextPart(part.id);

    expect(part.status).toBe("completed");
    expect(part.completedAt).toBeDefined();
    expect(eventBus.emit).toHaveBeenCalledWith(
      "agent.message.part.updated",
      expect.objectContaining({
        partId: part.id,
        patch: expect.objectContaining({ status: "completed" }),
      }),
      expect.anything(),
    );
  });

  // ── Status parts ─────────────────────────────────────────────
  it("startStatus creates a running status part", () => {
    const part = stream.startStatus({
      label: "正在调用工具: search",
      toolCallId: "tc-1",
    });

    expect(part.type).toBe("status");
    expect(part.status).toBe("running");
    expect(part.label).toBe("正在调用工具: search");
    expect(part.toolCallId).toBe("tc-1");
  });

  it("updateStatus updates label, status, and completedAt", () => {
    const part = stream.startStatus({ label: "调用中" });
    stream.updateStatus(part.id, {
      status: "completed",
      label: "完成",
    });

    expect(part.status).toBe("completed");
    expect(part.label).toBe("完成");
    expect(part.completedAt).toBeDefined();
  });

  it("updateStatus emits part.updated with patch", () => {
    const part = stream.startStatus({ label: "调用中" });
    stream.updateStatus(part.id, { status: "failed", label: "失败" });

    expect(eventBus.emit).toHaveBeenCalledWith(
      "agent.message.part.updated",
      expect.objectContaining({
        partId: part.id,
        patch: expect.objectContaining({ status: "failed", label: "失败" }),
      }),
      expect.anything(),
    );
  });

  // ── Tool use / result parts ──────────────────────────────────
  it("addToolUse creates tool_use part with pending status", () => {
    const part = stream.addToolUse({
      toolCallId: "tc-1",
      skillId: "search",
      name: "搜索代码",
      inputPreview: { query: "DELETE" },
    });

    expect(part.type).toBe("tool_use");
    expect(part.status).toBe("pending");
    expect(part.toolCallId).toBe("tc-1");
    expect(part.inputPreview).toEqual({ query: "DELETE" });
  });

  it("updateToolUse changes tool_use status", () => {
    const part = stream.addToolUse({
      toolCallId: "tc-1",
      skillId: "search",
      name: "搜索",
    });

    stream.updateToolUse("tc-1", { status: "running" });
    expect(part.status).toBe("running");

    stream.updateToolUse("tc-1", { status: "completed" });
    expect(part.status).toBe("completed");
  });

  it("updateToolUse emits part.updated", () => {
    stream.addToolUse({
      toolCallId: "tc-1",
      skillId: "search",
      name: "搜索",
    });
    stream.updateToolUse("tc-1", { status: "completed" });

    expect(eventBus.emit).toHaveBeenCalledWith(
      "agent.message.part.updated",
      expect.objectContaining({
        patch: expect.objectContaining({ status: "completed" }),
      }),
      expect.anything(),
    );
  });

  it("addToolResult creates tool_result part", () => {
    const part = stream.addToolResult({
      toolCallId: "tc-1",
      skillId: "search",
      summary: "Found 3 files",
      artifactIds: ["art-1"],
    });

    expect(part.type).toBe("tool_result");
    expect(part.visible).toBe("collapsed");
    expect(part.summary).toBe("Found 3 files");
    expect(part.artifactIds).toEqual(["art-1"]);
  });

  // ── Error parts ──────────────────────────────────────────────
  it("addError creates error part", () => {
    const part = stream.addError({
      message: "Something went wrong",
      code: "TEST_ERROR",
    });

    expect(part.type).toBe("error");
    expect(part.message).toBe("Something went wrong");
    expect(part.code).toBe("TEST_ERROR");
  });

  // ── Completion ───────────────────────────────────────────────
  it("complete merges text parts into content", async () => {
    const text1 = stream.startTextPart();
    stream.appendText(text1.id, "Hello");
    stream.completeTextPart(text1.id);

    const text2 = stream.startTextPart();
    stream.appendText(text2.id, " World");
    stream.completeTextPart(text2.id);

    const result = await stream.complete();

    expect(result.content).toBe("Hello\n World");
    expect(result.parts.length).toBeGreaterThanOrEqual(2);
  });

  it("complete does not include status/tool parts in content", async () => {
    const text = stream.startTextPart();
    stream.appendText(text.id, "Looking into this...");
    stream.completeTextPart(text.id);

    stream.startStatus({ label: "正在调用工具" });
    stream.addToolResult({
      toolCallId: "tc-1",
      skillId: "search",
      summary: "Found results",
    });

    const result = await stream.complete();

    // Content should only have text parts, not status/tool parts
    expect(result.content).toBe("Looking into this...");
    expect(result.content).not.toContain("正在调用工具");
    expect(result.content).not.toContain("Found results");
  });

  it("complete saves message with parts in metadata", async () => {
    const text = stream.startTextPart();
    stream.appendText(text.id, "Response text");
    stream.completeTextPart(text.id);

    await stream.complete();

    expect(saveMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "msg-1",
        conversationId: "conv-1",
        role: "assistant",
        content: "Response text",
        runId: "run-1",
        metadata: expect.objectContaining({
          parts: expect.any(Array),
          toolCallIds: expect.any(Array),
          artifactIds: expect.any(Array),
        }),
      }),
    );
  });

  it("complete emits agent.message.completed with parts", async () => {
    const text = stream.startTextPart();
    stream.appendText(text.id, "Done");
    stream.completeTextPart(text.id);

    await stream.complete();

    expect(eventBus.emit).toHaveBeenCalledWith(
      "agent.message.completed",
      expect.objectContaining({
        runId: "run-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        content: "Done",
        parts: expect.any(Array),
      }),
      expect.anything(),
    );
  });

  it("complete is idempotent", async () => {
    const text = stream.startTextPart();
    stream.appendText(text.id, "Once");
    stream.completeTextPart(text.id);

    const first = await stream.complete();
    const second = await stream.complete();

    expect(first.content).toBe(second.content);
    // saveMessage should only be called once
    expect(saveMessage).toHaveBeenCalledTimes(1);
  });

  // ── Full content-block flow simulation ────────────────────────
  it("supports text → status → text → tool_result → text interleaving", async () => {
    // Simulate a Codex-style content-block flow:
    // 1. AI says what it's about to do
    const text1 = stream.startTextPart();
    stream.appendText(text1.id, "我先检查相关代码。");
    stream.completeTextPart(text1.id);

    // 2. Tool starts
    stream.addToolUse({
      toolCallId: "tc-1",
      skillId: "search",
      name: "搜索代码",
    });
    stream.updateToolUse("tc-1", { status: "running" });

    const status = stream.startStatus({
      label: "正在调用工具: 搜索代码",
      toolCallId: "tc-1",
    });

    // 3. Tool completes
    stream.updateStatus(status.id, { status: "completed", label: "完成: 搜索代码" });
    stream.updateToolUse("tc-1", { status: "completed" });
    stream.addToolResult({
      toolCallId: "tc-1",
      skillId: "search",
      summary: "找到相关代码路径",
    });

    // 4. AI continues with observations
    const text2 = stream.startTextPart();
    stream.appendText(text2.id, "找到问题。DELETE 请求缺少 body 时...");
    stream.completeTextPart(text2.id);

    const result = await stream.complete();

    // Verify parts order
    const types = result.parts.map((p) => p.type);
    expect(types).toEqual([
      "text",
      "tool_use",
      "status",
      "tool_result",
      "text",
    ]);

    // Verify content = text parts only
    expect(result.content).toContain("我先检查相关代码");
    expect(result.content).toContain("DELETE 请求缺少 body");
    expect(result.content).not.toContain("搜索代码");
  });
});
