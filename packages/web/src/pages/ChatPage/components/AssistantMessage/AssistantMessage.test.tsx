import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ChatMessage } from "../../../../features/conversations/types";
import { AssistantMessage } from "./AssistantMessage";

afterEach(cleanup);

function assistantMessage(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "assistant_1",
    conversationId: "conversation_1",
    role: "assistant",
    content: "",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AssistantMessage streaming presentation", () => {
  test("shows immediate feedback for an optimistic pending placeholder", () => {
    render(
      <AssistantMessage
        message={assistantMessage({ status: "pending" })}
        isStreaming={true}
        sendState="sending"
      />,
    );

    expect(screen.getByText("正在思考")).toBeInTheDocument();
    expect(screen.getByText("正在连接 SunPilot...")).toBeInTheDocument();
  });

  test("keeps a banner visible after an empty progress part starts", () => {
    render(
      <AssistantMessage
        message={assistantMessage({
          status: "streaming",
          parts: [
            {
              id: "text_1",
              type: "text",
              content: "",
              source: "model",
              status: "streaming",
              semanticRole: "progress",
              createdAt: "2026-07-01T00:00:00.000Z",
            },
          ],
        })}
        isStreaming={true}
      />,
    );

    expect(screen.getByText("正在思考")).toBeInTheDocument();
    expect(screen.getByText("正在分析...")).toBeInTheDocument();
  });

  test("renders streaming progress deltas provisionally in the main area", () => {
    render(
      <AssistantMessage
        message={assistantMessage({
          status: "streaming",
          parts: [
            {
              id: "text_1",
              type: "text",
              content: "你好，我正在流式回答",
              source: "model",
              status: "streaming",
              semanticRole: "progress",
              createdAt: "2026-07-01T00:00:00.000Z",
            },
          ],
        })}
        isStreaming={true}
      />,
    );

    expect(screen.getByText("你好，我正在流式回答")).toBeInTheDocument();
  });

  test("renders only one fallback banner for an unassociated recoverable error", () => {
    render(
      <AssistantMessage
        message={assistantMessage({
          status: "streaming",
          parts: [
            {
              id: "error_1",
              type: "error",
              message: "temporary tool error",
              recoverable: true,
              createdAt: "2026-07-01T00:00:00.000Z",
            },
          ],
        })}
        isStreaming={true}
      />,
    );

    expect(screen.getAllByText("正在思考")).toHaveLength(1);
  });
});
