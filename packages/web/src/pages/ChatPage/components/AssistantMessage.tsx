import { useState, useCallback, useRef } from "react";
import { Flex, Button, Typography, message } from "antd";
import {
  CopyOutlined,
  LikeOutlined,
  LikeFilled,
  DislikeOutlined,
  DislikeFilled,
  LoadingOutlined,
  ToolOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { ChatMessage } from "../../../features/conversations/types";
import type { LocalSendState } from "../types";
import { formatTime } from "../../../shared/utils/formatTime";
import { MarkdownRenderer, RichCardRenderer } from "../../../rich-cards";
import { StreamingCursor } from "./StreamingCursor";
import { TypingDots } from "./TypingDots";
import "./AssistantMessage.css";

const { Text } = Typography;

function getAiStatus(
  sendState?: LocalSendState,
  toolName?: string,
): { icon: React.ReactNode; text: string } | null {
  switch (sendState) {
    case "accepted":
      return { icon: <LoadingOutlined />, text: "正在分析需求..." };
    case "running":
      if (toolName) {
        return { icon: <ToolOutlined />, text: `正在调用工具: ${toolName}` };
      }
      return { icon: <LoadingOutlined />, text: "正在分析结果..." };
    case "streaming":
      return { icon: <ThunderboltOutlined />, text: "正在生成回答..." };
    default:
      return null;
  }
}

export function AssistantMessage({
  message: msg,
  isStreaming,
  cards,
  sendState,
  toolName,
}: {
  message: ChatMessage;
  isStreaming?: boolean;
  cards?: ChatMessage["cards"];
  sendState?: LocalSendState;
  toolName?: string;
}) {
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const likedRef = useRef(liked);
  const dislikedRef = useRef(disliked);
  likedRef.current = liked;
  dislikedRef.current = disliked;
  const hasContent = msg.content.length > 0;
  const isPending = msg.status === "pending";
  const aiStatus = getAiStatus(sendState, toolName);

  const handleCopy = useCallback(() => {
    const text = msg.content;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => message.success("已复制到剪贴板"))
        .catch(() => {});
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
        {/* ── AI status indicator (before content) ─────────────── */}
        {aiStatus && !hasContent && (
          <Flex align="center" gap={8} className="assistant-status">
            <span className="assistant-status__icon">{aiStatus.icon}</span>
            <Text type="secondary" className="assistant-status__text">
              {aiStatus.text}
            </Text>
          </Flex>
        )}

        {/* ── Text content ────────────────────────────────────── */}
        <div className="assistant-text">
          {!hasContent && isStreaming && !aiStatus ? <TypingDots /> : null}
          {!hasContent && isPending && !aiStatus ? <TypingDots /> : null}
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

        {/* ── AI status indicator (inline, below content) ────── */}
        {aiStatus && hasContent && (
          <Flex align="center" gap={8} className="assistant-status assistant-status--inline">
            <span className="assistant-status__icon">{aiStatus.icon}</span>
            <Text type="secondary" className="assistant-status__text">
              {aiStatus.text}
            </Text>
          </Flex>
        )}

        {/* ── Rich cards (video, image, etc.) ─────────────────── */}
        {cards && cards.length > 0 && <RichCardRenderer cards={cards} />}

        {/* ── Action row ─────────────────────────────────────── */}
        {!isStreaming && hasContent && (
          <Flex align="center" gap={4} className="assistant-actions">
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
