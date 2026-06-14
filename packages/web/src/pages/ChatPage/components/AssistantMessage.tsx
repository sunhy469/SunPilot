import type { ReactNode } from "react";
import { Avatar, Typography, Tag, Space } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import type { ChatMessage } from "../../../features/conversations/types";
import { assistantDisplayName } from "../../../features/chat/model";
import { formatTime } from "../../../shared/utils/formatTime";
import { StreamingCursor } from "./StreamingCursor";
import { TypingDots } from "./TypingDots";
import "./AssistantMessage.css";

const { Text, Paragraph } = Typography;

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
      <Avatar
        size="small"
        src="/logo.png"
        icon={<RobotOutlined />}
        className="assistant-avatar"
      />

      <div className="assistant-content">
        <Space size={8} className="assistant-meta">
          <Text strong>{assistantDisplayName}</Text>
          {message.createdAt && (
            <Text type="secondary" className="message-time">
              {formatTime(message.createdAt)}
            </Text>
          )}
          {isStreaming && hasContent && (
            <Tag color="processing">生成中</Tag>
          )}
        </Space>

        <div className="assistant-text">
          {!hasContent && isStreaming ? <TypingDots /> : null}
          {hasContent && (
            <Paragraph style={{ margin: 0 }}>
              <Text className="assistant-text-content">{message.content}</Text>
              {isStreaming && <StreamingCursor />}
            </Paragraph>
          )}
        </div>

        {cards}
      </div>
    </div>
  );
}
