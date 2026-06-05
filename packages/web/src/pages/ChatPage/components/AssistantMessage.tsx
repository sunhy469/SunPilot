import type { ReactNode } from "react";
import type { ChatMessage } from "../../../features/conversations/types";
import { assistantDisplayName } from "../../../features/chat/model";
import { formatTime } from "../../../shared/utils/formatTime";
import { StreamingCursor } from "./StreamingCursor";
import { TypingDots } from "./TypingDots";
import "./AssistantMessage.css";

export function AssistantMessage({
  message,
  isStreaming,
  cards,
}: {
  message: ChatMessage;
  isStreaming?: boolean;
  cards?: ReactNode;
}) {
  const hasContent = message.content.length > 0;

  return (
    <div className="message-row assistant">
      <div className="assistant-avatar">SP</div>

      <div className="assistant-content">
        <div className="assistant-meta">
          <span className="assistant-name">{assistantDisplayName}</span>
          {message.createdAt && (
            <span className="message-time">
              {formatTime(message.createdAt)}
            </span>
          )}
          {isStreaming && hasContent && (
            <span className="streaming-badge">生成中</span>
          )}
        </div>

        <div className="assistant-text">
          {!hasContent && isStreaming ? <TypingDots /> : null}
          {hasContent && (
            <>
              <span className="assistant-text-content">{message.content}</span>
              {isStreaming && <StreamingCursor />}
            </>
          )}
        </div>

        {cards}
      </div>
    </div>
  );
}
