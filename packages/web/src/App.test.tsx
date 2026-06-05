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
        this.dispatchEvent(new CloseEvent("close", { code: 1011, reason: "network lost" }));
        return;
      }
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }

  send(value: string) {
    const request = JSON.parse(value) as { method: string; params: { message: string } };
    this.sent.push(request);
    if (request.method !== "chat.send") return;
    const user = { id: "msg_user", conversationId: "conv_1", role: "user", content: request.params.message, createdAt: "2026-06-05T00:00:00.000Z" };
    const assistant = { id: "msg_assistant", conversationId: "conv_1", role: "assistant", content: "assistant reply", createdAt: "2026-06-05T00:00:01.000Z" };
    this.emit({ method: "chat.message.created", params: { conversationId: "conv_1", message: user } });
    this.emit({ method: "chat.assistant.started", params: { conversationId: "conv_1", messageId: assistant.id } });
    this.emit({ method: "chat.assistant.delta", params: { conversationId: "conv_1", messageId: assistant.id, delta: assistant.content } });
    if (FakeWebSocket.holdCompletion) return;
    this.emit({ method: "chat.assistant.completed", params: { conversationId: "conv_1", message: assistant } });
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close"));
  }

  private emit(payload: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

describe("Web ChatPage", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.holdCompletion = false;
    FakeWebSocket.closeBeforeOpen = false;
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      if (path === "/v1/conversations") {
        return Response.json({ items: [{ id: "conv_1", title: "Existing Chat", status: "active", createdAt: "2026-06-05T00:00:00.000Z", updatedAt: "2026-06-05T00:00:00.000Z" }] });
      }
      if (path === "/v1/conversations/conv_1/messages") {
        return Response.json({ conversationId: "conv_1", items: [] });
      }
      return Response.json({ ok: true });
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("loads conversations and sends chat over WebSocket", async () => {
    render(<App />);

    await waitFor(() => expect(screen.getAllByText("Existing Chat").length).toBeGreaterThan(0));
    const textbox = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("assistant reply")).toBeInTheDocument());
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  test("fills a welcome quick action without sending immediately", async () => {
    render(<App />);

    await screen.findByText("你好，我是 SunPilot");
    expect(screen.queryByText("SunPilot daemon 暂时不可用")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /分析项目/ }));

    expect(screen.getByRole("textbox", { name: "Message" })).toHaveValue("请帮我分析这个项目的整体架构，并指出可以优化的地方。");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test("sends chat.stop when stopping a streaming response", async () => {
    FakeWebSocket.holdCompletion = true;
    render(<App />);

    const textbox = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "stream please");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    const stopButton = await screen.findByRole("button", { name: "Stop" });
    await userEvent.click(stopButton);

    expect(FakeWebSocket.instances[0]?.sent.some((message) => message.method === "chat.stop")).toBe(true);
  });

  test("shows an error when WebSocket closes before streaming starts", async () => {
    FakeWebSocket.closeBeforeOpen = true;
    render(<App />);

    const textbox = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "will fail");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("network lost")).toBeInTheDocument());
  });
});
