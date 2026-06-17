import { memo } from "react";
import { Spin } from "antd";
import type { ChatMessage } from "../../../features/conversations/types";
import type { ChatViewState, LocalSendState } from "../types";
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
}: {
  messages: ChatMessage[];
  status: ChatViewState;
  sendState?: LocalSendState;
  toolName?: string | null;
}) {
  const isStreaming = status === "streaming";
  const scrollRef = useAutoScroll([messages, status], isStreaming);

  if (messages.length === 0) {
    return null;
  }

  return (
    <div className="message-list" ref={scrollRef}>
      <div className="message-inner">
        {messages.map((message, idx) => {
          const isLast = idx === messages.length - 1;
          const isLastAssistant =
            message.role === "assistant" &&
            isLast &&
            isStreaming;

          if (message.role === "user") {
            return <MemoUserMessage key={message.id} message={message} />;
          }

          if (message.role === "assistant") {
            return (
              <MemoAssistantMessage
                key={message.id}
                message={message}
                isStreaming={isLastAssistant}
                cards={message.cards}
                sendState={isLast ? sendState : undefined}
                toolName={isLast ? (toolName ?? undefined) : undefined}
              />
            );
          }

          return null;
        })}

        {status === "loadingConversation" && (
          <div className="message-list__loading">
            <Spin size="small" /> 加载对话中...
          </div>
        )}
      </div>
    </div>
  );
}
