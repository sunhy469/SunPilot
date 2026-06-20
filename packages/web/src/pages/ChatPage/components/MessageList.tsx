import { memo } from "react";
import { Spin, Flex, Typography } from "antd";
import type { ChatMessage } from "../../../features/conversations/types";
import type { ChatViewState, LocalSendState } from "../types";
import type { RichCardAction } from "../../../rich-cards/types";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import "./MessageList.css";

const MemoUserMessage = memo(UserMessage);
const MemoAssistantMessage = memo(AssistantMessage);

export function MessageList({
  messages,
  status,
  sendState,
  toolName,
  onCardAction,
}: {
  messages: ChatMessage[];
  status: ChatViewState;
  sendState?: LocalSendState;
  toolName?: string | null;
  onCardAction?: (messageId: string, action: RichCardAction) => void;
}) {
  const isStreaming = status === "streaming";
  const scrollRef = useAutoScroll([messages, status], isStreaming);

  // Find the active assistant: the last assistant message with pending/streaming status.
  // This ensures sendState/toolName/isStreaming are passed to the correct message
  // even if a server user message was temporarily inserted after the assistant placeholder.
  const activeAssistantIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]!;
      if (
        msg.role === "assistant" &&
        (msg.status === "pending" || msg.status === "streaming")
      ) {
        return i;
      }
    }
    // Fallback: last assistant message if no active one
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "assistant") return i;
    }
    return -1;
  })();

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="message-list" ref={scrollRef}>
      <div className="message-inner">
        {messages.map((message, idx) => {
          const isActiveAssistant = idx === activeAssistantIdx;

          if (message.role === "user") {
            return <MemoUserMessage key={message.id} message={message} />;
          }

          if (message.role === "assistant") {
            return (
              <MemoAssistantMessage
                key={message.id}
                message={message}
                isStreaming={isActiveAssistant && isStreaming}
                cards={message.cards}
                cardStateByCardId={message.cardStateByCardId}
                sendState={isActiveAssistant ? sendState : undefined}
                toolName={isActiveAssistant ? (toolName ?? undefined) : undefined}
                onCardAction={onCardAction ? (action) => onCardAction(message.id, action) : undefined}
              />
            );
          }

          return null;
        })}

        {status === "loadingConversation" && (
          <Flex align="center" justify="center" gap={8} className="message-list__loading">
            <Spin size="small" />
            <Typography.Text type="secondary">加载对话中...</Typography.Text>
          </Flex>
        )}
      </div>
    </div>
  );
}
