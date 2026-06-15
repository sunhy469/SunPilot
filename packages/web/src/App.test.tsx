import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "./app/App";

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  static holdCompletion = false;
  static closeBeforeOpen = false;
  readyState = FakeWebSocket.CONNECTING;
  sent: Array<{ method: string; params?: unknown }> = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      if (FakeWebSocket.closeBeforeOpen) {
        this.readyState = 3;
        this.dispatchEvent(
          new CloseEvent("close", { code: 1011, reason: "network lost" }),
        );
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }

  send(value: string) {
    const request = JSON.parse(value) as {
      method: string;
      params: { message: string };
    };
    this.sent.push(request);
    if (request.method !== "chat.send") return;
    const assistant = {
      id: "msg_assistant",
      content: "assistant reply",
    };
    this.emit({
      method: "agent.run.created",
      params: {
        runId: "run_1",
        conversationId: "conv_1",
        mode: "agent",
      },
    });
    this.emit({
      method: "agent.context.completed",
      params: {
        runId: "run_1",
        tokenEstimate: 120,
      },
    });
    this.emit({
      method: "agent.intent.detected",
      params: {
        runId: "run_1",
        intent: "file_operation",
        confidence: 0.9,
        candidateSkills: ["filesystem.read"],
      },
    });
    this.emit({
      method: "agent.tool.selected",
      params: {
        runId: "run_1",
        toolCallId: "tool_1",
        skillId: "filesystem.read",
        name: "Read File",
        riskLevel: "low",
      },
    });
    this.emit({
      method: "agent.tool.delta",
      params: {
        runId: "run_1",
        toolCallId: "tool_1",
        delta: "Reading report.md",
      },
    });
    this.emit({
      method: "agent.tool.completed",
      params: {
        runId: "run_1",
        toolCallId: "tool_1",
        skillId: "filesystem.read",
        summary: "Read completed",
      },
    });
    this.emit({
      method: "agent.artifact.created",
      params: {
        runId: "run_1",
        artifactId: "artifact_1",
        name: "report.md",
        type: "markdown",
        version: 2,
      },
    });
    this.emit({
      method: "agent.approval.expired",
      params: {
        runId: "run_1",
        approvalId: "approval_1",
        title: "Approve old shell",
        riskLevel: "high",
        runCancelled: false,
      },
    });
    this.emit({
      method: "agent.response.started",
      params: {
        runId: "run_1",
        conversationId: "conv_1",
        messageId: assistant.id,
      },
    });
    this.emit({
      method: "agent.response.delta",
      params: {
        runId: "run_1",
        conversationId: "conv_1",
        messageId: assistant.id,
        delta: assistant.content,
      },
    });
    if (FakeWebSocket.holdCompletion) return;
    this.emit({
      method: "agent.response.completed",
      params: {
        runId: "run_1",
        conversationId: "conv_1",
        messageId: assistant.id,
      },
    });
    this.emit({
      method: "agent.run.completed",
      params: {
        runId: "run_1",
        assistantMessageId: assistant.id,
        artifacts: [],
        toolCalls: 0,
      },
    });
    this.emit({
      method: "agent.run.interrupted",
      params: {
        runId: "run_2",
        reason: "daemon restart",
      },
    });
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close"));
  }

  private emit(payload: unknown) {
    const event = payload as { method?: string; params?: unknown };
    const framed =
      typeof event.method === "string" && event.method.startsWith("agent.")
        ? {
            ...event,
            params: {
              eventId: `evt_${crypto.randomUUID()}`,
              sequence: 1,
              runId:
                event.params && typeof event.params === "object"
                  ? (event.params as { runId?: string }).runId
                  : undefined,
              conversationId:
                event.params && typeof event.params === "object"
                  ? (event.params as { conversationId?: string }).conversationId
                  : undefined,
              createdAt: "2026-06-06T00:00:00.000Z",
              payload: event.params,
            },
          }
        : payload;
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(framed) }),
    );
  }
}

describe("Web ChatPage", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.holdCompletion = false;
    FakeWebSocket.closeBeforeOpen = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string) => {
        if (path === "/v1/conversations") {
          return Response.json({
            items: [
              {
                id: "conv_1",
                title: "Existing Chat",
                status: "active",
                createdAt: "2026-06-05T00:00:00.000Z",
                updatedAt: "2026-06-05T00:00:00.000Z",
              },
            ],
          });
        }
        if (path === "/v1/conversations/conv_1/messages") {
          return Response.json({ conversationId: "conv_1", items: [] });
        }
        return Response.json({ ok: true });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("loads conversations and sends chat over WebSocket", async () => {
    render(<App />);

    await waitFor(() =>
      expect(screen.getAllByText("Existing Chat").length).toBeGreaterThan(0),
    );
    const textbox = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "hello");
    // The send button uses aria-label "发送" (Chinese)
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(screen.getByText("assistant reply")).toBeInTheDocument(),
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  test("renders a clean welcome state without opening a socket", async () => {
    render(<App />);

    await screen.findByText("你好，我是 SunPilot，有什么可以帮到您？");
    expect(
      screen.queryByText("SunPilot daemon 暂时不可用"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test("shows the plugin panel in the chat workspace", async () => {
    render(<App />);

    await screen.findByText("你好，我是 SunPilot，有什么可以帮到您？");
    await userEvent.click(screen.getByRole("button", { name: "appstore 插件" }));

    expect(
      screen.getByRole("heading", { name: "插件空间暂时为空" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Message" }),
    ).not.toBeInTheDocument();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test("sends chat.stop when stopping a streaming response", async () => {
    FakeWebSocket.holdCompletion = true;
    render(<App />);

    const textbox = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "stream please");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    const stopButton = await screen.findByRole("button", { name: "停止" });
    await userEvent.click(stopButton);

    expect(
      FakeWebSocket.instances[0]?.sent.some(
        (message) => message.method === "chat.stop",
      ),
    ).toBe(true);
  });

  test("shows an error when WebSocket closes before streaming starts", async () => {
    FakeWebSocket.closeBeforeOpen = true;
    render(<App />);

    const textbox = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "will fail");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() =>
      expect(screen.getByText("network lost")).toBeInTheDocument(),
    );
  });
});
