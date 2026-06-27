import { memo, useLayoutEffect, useRef } from "react";
import { Flex, Typography } from "antd";
import { HourglassOutlined } from "@ant-design/icons";
import type { ChatMessage } from "../../../../features/conversations/types";
import type { ChatViewState, LocalSendState } from "../../types";
import type { RichCardAction } from "../../../../rich-cards/types";
import { useAutoScroll } from "../../hooks/useAutoScroll";
import { UserMessage } from "../UserMessage/UserMessage";
import { AssistantMessage } from "../AssistantMessage/AssistantMessage";
import "./MessageList.scss";

const MemoUserMessage = memo(UserMessage);
const MemoAssistantMessage = memo(AssistantMessage);

function HistoryLoadingIndicator() {
  return (
    <Flex vertical align="center" justify="center" gap={10} className="message-list__loading">
      <HourglassOutlined className="message-list__hourglass" />
      <Typography.Text type="secondary">正在加载历史会话...</Typography.Text>
    </Flex>
  );
}

export function MessageList({
  messages,
  status,
  sendState,
  toolName,
  onCardAction,
  loadingMessages,
}: {
  messages: ChatMessage[];
  status: ChatViewState;
  sendState?: LocalSendState;
  toolName?: string | null;
  onCardAction?: (messageId: string, action: RichCardAction) => void;
  /** True while messages are being fetched for the current conversation. */
  loadingMessages?: boolean;
}) {
  const isStreaming = status === "streaming";

  // Force-scroll ref: when a new user message appears, we scroll to it
  // even if the user had previously scrolled up.
  const forceScrollRef = useRef({ value: false });
  const historyLoadPendingRef = useRef(false);
  if (loadingMessages) historyLoadPendingRef.current = true;
  const shouldSnapHistoryToBottom =
    !loadingMessages && historyLoadPendingRef.current && messages.length > 0;
  const prevUserMsgCountRef = useRef(0);
  const currentUserMsgCount = messages.filter((m) => m.role === "user").length;
  if (currentUserMsgCount > prevUserMsgCountRef.current) {
    forceScrollRef.current.value = true;
  }
  prevUserMsgCountRef.current = currentUserMsgCount;

  const scrollRef = useAutoScroll(
    [messages, status],
    isStreaming || shouldSnapHistoryToBottom,
    forceScrollRef,
  );

  useLayoutEffect(() => {
    if (!shouldSnapHistoryToBottom) return;
    historyLoadPendingRef.current = false;
    const container = scrollRef.current;
    if (!container) return;

    let keepPinned = true;
    const scrollToLatest = () => {
      if (keepPinned) container.scrollTop = container.scrollHeight;
    };
    const stopPinning = () => {
      keepPinned = false;
    };

    scrollToLatest();
    const frame = window.requestAnimationFrame(scrollToLatest);
    container.addEventListener("wheel", stopPinning, { passive: true });
    container.addEventListener("touchstart", stopPinning, { passive: true });

    const observer = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(scrollToLatest);
    const messageInner = container.querySelector(".message-inner");
    if (messageInner) observer?.observe(messageInner);
    const timer = window.setTimeout(() => observer?.disconnect(), 2_000);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      observer?.disconnect();
      container.removeEventListener("wheel", stopPinning);
      container.removeEventListener("touchstart", stopPinning);
    };
  }, [scrollRef, shouldSnapHistoryToBottom]);

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

  // Show a loading spinner while messages are being fetched for a new
  // conversation. We still render the .message-list container (flex: 1)
  // so the composer stays pinned to the bottom of the page.
  if (messages.length === 0 && !loadingMessages) {
    return null;
  }

  if (messages.length === 0 && loadingMessages) {
    return (
      <div className="message-list">
        <HistoryLoadingIndicator />
      </div>
    );
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
          <HistoryLoadingIndicator />
        )}
      </div>
    </div>
  );
}
