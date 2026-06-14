import { useState, useCallback, type ReactNode } from "react";
import { Flex, Button, Typography, message } from "antd";
import {
  CopyOutlined,
  LikeOutlined,
  LikeFilled,
  DislikeOutlined,
  DislikeFilled,
} from "@ant-design/icons";
import type { ChatMessage } from "../../../features/conversations/types";
import { formatTime } from "../../../shared/utils/formatTime";
import { MarkdownRenderer } from "../../../rich-cards";
import { StreamingCursor } from "./StreamingCursor";
import { TypingDots } from "./TypingDots";
import "./AssistantMessage.css";

const { Text } = Typography;

export function AssistantMessage({
  message: msg,
  isStreaming,
  cards,
}: {
  message: ChatMessage;
  isStreaming?: boolean;
  cards?: ReactNode;
}) {
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const hasContent = msg.content.length > 0;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(msg.content).then(() => {
      message.success("已复制");
    });
  }, [msg.content]);

  const handleLike = useCallback(() => {
    setLiked((v) => !v);
    if (disliked) setDisliked(false);
  }, [disliked]);

  const handleDislike = useCallback(() => {
    setDisliked((v) => !v);
    if (liked) setLiked(false);
  }, [liked]);

  return (
    <div className="message-row assistant">
      <div className="assistant-content">
        <div className="assistant-text">
          {!hasContent && isStreaming ? <TypingDots /> : null}
          {hasContent && (
            <div className="assistant-markdown-wrap">
              <MarkdownRenderer
                content={msg.content}
                isStreaming={!!isStreaming}
              />
              {isStreaming && <StreamingCursor />}
            </div>
          )}
        </div>

        {cards}

        {/* Action row: copy / like / dislike / time */}
        {!isStreaming && hasContent && (
          <Flex
            align="center"
            gap={4}
            className="assistant-actions"
          >
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              onClick={handleCopy}
            />
            <Button
              type="text"
              size="small"
              icon={liked ? <LikeFilled /> : <LikeOutlined />}
              onClick={handleLike}
            />
            <Button
              type="text"
              size="small"
              icon={disliked ? <DislikeFilled /> : <DislikeOutlined />}
              onClick={handleDislike}
            />
            {msg.createdAt && (
              <Text type="secondary" className="message-time">
                {formatTime(msg.createdAt)}
              </Text>
            )}
          </Flex>
        )}
      </div>
    </div>
  );
}
