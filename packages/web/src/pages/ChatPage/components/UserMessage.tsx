import { Card, Avatar, Typography, Space } from "antd";
import { UserOutlined } from "@ant-design/icons";
import type { ChatMessage } from "../../../features/conversations/types";
import { formatTime } from "../../../shared/utils/formatTime";
import "./UserMessage.css";

const { Text, Paragraph } = Typography;

export function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="message-row user">
      <div className="user-bubble">
        <Card size="small" className="user-card">
          <Paragraph style={{ margin: 0 }}>{message.content}</Paragraph>
        </Card>
      </div>
      <Space size={8}>
        <Avatar size="small" icon={<UserOutlined />} style={{ backgroundColor: "#6366f1" }}>
          You
        </Avatar>
        {message.createdAt && (
          <Text type="secondary" className="message-time">
            {formatTime(message.createdAt)}
          </Text>
        )}
      </Space>
    </div>
  );
}
