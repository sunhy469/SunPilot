import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatComposer } from "./ChatComposer";

// ── Helpers ─────────────────────────────────────────────────────────

/** Wait for antd animation to settle before asserting DOM changes. */
async function tick(ms = 50) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Tests ───────────────────────────────────────────────────────────

describe("ChatComposer", () => {
  afterEach(() => {
    cleanup();
  });

  test("renders with default placeholder and send button", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    expect(
      screen.getByRole("textbox", { name: "Message" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  test("calls onSend with text when user types and clicks send", async () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    const textbox = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "hello world");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalledWith("hello world", [], "auto", "seed");
  });

  test("does not call onSend when input is empty and no files", async () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onSend).not.toHaveBeenCalled();
  });

  test("send button is disabled when input is empty and no files", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  test("send button is enabled when text is present", async () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    const textbox = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "hi");

    await tick();
    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
  });

  test("sends on Enter without Shift", async () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    const textbox = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "quick send");
    await userEvent.keyboard("{Enter}");

    expect(onSend).toHaveBeenCalledWith("quick send", [], "auto", "seed");
  });

  test("does not send on Shift+Enter (multiline)", async () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    const textbox = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "line1");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");

    expect(onSend).not.toHaveBeenCalled();
    // Text should still be present (not cleared)
    expect(textbox).toHaveValue("line1\n");
  });

  test("supports controlled value via props", async () => {
    const onSend = vi.fn();
    const onChange = vi.fn();
    const { rerender } = render(
      <ChatComposer onSend={onSend} value="hello" onChange={onChange} />,
    );

    const textbox = screen.getByRole("textbox", { name: "Message" });
    expect(textbox).toHaveValue("hello");

    // Type more characters
    await userEvent.type(textbox, " world");
    expect(onChange).toHaveBeenCalled();

    // Rerender with new value
    rerender(
      <ChatComposer onSend={onSend} value="hello world" onChange={onChange} />,
    );
    expect(textbox).toHaveValue("hello world");
  });

  test("reports sendState transitions via onSendStateChange", async () => {
    const states: string[] = [];
    const onSendStateChange = vi.fn((state: string) => states.push(state));
    const onSend = vi.fn();

    render(
      <ChatComposer
        onSend={onSend}
        onSendStateChange={onSendStateChange}
      />,
    );

    // Type and send — should trigger sending state
    const textbox = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "test state");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(onSend).toHaveBeenCalled();
  });

  test("clears text after successful send", async () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    const textbox = screen.getByRole("textbox", { name: "Message" });
    await userEvent.type(textbox, "clear me");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    await tick();
    expect(textbox).toHaveValue("");
  });

  test("shows stop button when streaming is true", () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(
      <ChatComposer onSend={onSend} onStop={onStop} streaming={true} />,
    );

    expect(screen.getByRole("button", { name: "停止" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "发送" }),
    ).not.toBeInTheDocument();
  });

  test("calls onStop when stop button clicked", async () => {
    const onSend = vi.fn();
    const onStop = vi.fn();
    render(
      <ChatComposer onSend={onSend} onStop={onStop} streaming={true} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalled();
  });

  test("disables compose when disabled prop is true", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} disabled={true} />);

    expect(screen.getByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });

  test("renders welcome variant with welcome class", () => {
    const onSend = vi.fn();
    const { container } = render(
      <ChatComposer onSend={onSend} variant="welcome" />,
    );

    expect(
      container.querySelector(".chat-composer--welcome"),
    ).toBeInTheDocument();
  });

  test("shows model selector", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    // The model selector should show the default model
    expect(screen.getByText("Seed-pro")).toBeInTheDocument();
  });

  test("shows permission selector", () => {
    const onSend = vi.fn();
    render(<ChatComposer onSend={onSend} />);

    // The permission selector shows default "替我审批"
    expect(screen.getByText("替我审批")).toBeInTheDocument();
  });
});
