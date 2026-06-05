import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "./app/App";

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    setTimeout(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    }, 0);
  }

  send(value: string) {
    const request = JSON.parse(value) as { method: string; params: { message: string } };
    if (request.method !== "chat.send") return;
    const user = { id: "msg_user", conversationId: "conv_1", role: "user", content: request.params.message, createdAt: "2026-06-05T00:00:00.000Z" };
    const assistant = { id: "msg_assistant", conversationId: "conv_1", role: "assistant", content: "assistant reply", createdAt: "2026-06-05T00:00:01.000Z" };
    this.emit({ method: "chat.message.created", params: { conversationId: "conv_1", message: user } });
    this.emit({ method: "chat.assistant.started", params: { conversationId: "conv_1", messageId: assistant.id } });
    this.emit({ method: "chat.assistant.delta", params: { conversationId: "conv_1", messageId: assistant.id, delta: assistant.content } });
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
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  test("loads conversations and sends chat over WebSocket", async () => {
    render(<App token="sun_test" />);

    await waitFor(() => expect(screen.getAllByText("Existing Chat").length).toBeGreaterThan(0));
    const textbox = await screen.findByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("assistant reply")).toBeInTheDocument());
    expect(screen.getByText("hello")).toBeInTheDocument();
  });
});
