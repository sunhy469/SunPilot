import { memo } from "react";
import { Spin } from "antd";
import type { ChatMessage } from "../../../features/conversations/types";
import type { ChatViewState } from "../types";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { UserMessage } from "./UserMessage";
import { AssistantMessage } from "./AssistantMessage";
import { RichCardRenderer } from "../../../rich-cards";
import "./MessageList.css";

const MemoUserMessage = memo(UserMessage);
const MemoAssistantMessage = memo(AssistantMessage);

export function MessageList({
  messages,
  status,
}: {
  messages: ChatMessage[];
  status: ChatViewState;
}) {
  const scrollRef = useAutoScroll([messages, status]);

  if (messages.length === 0) {
    return null;
  }

  const isStreaming = status === "streaming";

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
                cards={
                  message.cards && message.cards.length > 0 ? (
                    <RichCardRenderer cards={message.cards} />
                  ) : undefined
                }
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
