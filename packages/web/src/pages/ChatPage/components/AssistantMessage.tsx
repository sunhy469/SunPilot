import { useState, useCallback, useRef } from "react";
import { Flex, Button, Typography } from "antd";
import {
  CopyOutlined,
  LikeOutlined,
  LikeFilled,
  DislikeOutlined,
  DislikeFilled,
} from "@ant-design/icons";
import type { ChatMessage } from "../../../features/conversations/types";
import { formatTime } from "../../../shared/utils/formatTime";
import { MarkdownRenderer, RichCardRenderer } from "../../../rich-cards";
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
  cards?: ChatMessage["cards"];
}) {
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const likedRef = useRef(liked);
  const dislikedRef = useRef(disliked);
  likedRef.current = liked;
  dislikedRef.current = disliked;
  const hasContent = msg.content.length > 0;

  const handleCopy = useCallback(() => {
    const text = msg.content;
    // Clipboard API may not be available in insecure contexts
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        // Silently fail — the text is still visible
      });
    }
  }, [msg.content]);

  const handleLike = useCallback(() => {
    if (dislikedRef.current) setDisliked(false);
    setLiked((v) => !v);
  }, []);

  const handleDislike = useCallback(() => {
    if (likedRef.current) setLiked(false);
    setDisliked((v) => !v);
  }, []);

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

        {cards && cards.length > 0 && <RichCardRenderer cards={cards} />}

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
