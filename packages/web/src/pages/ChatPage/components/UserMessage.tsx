import { Card, Typography } from "antd";
import type { ChatMessage } from "../../../features/conversations/types";
import "./UserMessage.css";

const { Paragraph } = Typography;

export function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="message-row user">
      <div className="user-bubble">
        <Card size="small" className="user-card">
          <Paragraph style={{ margin: 0 }}>{message.content}</Paragraph>
        </Card>
      </div>
    </div>
  );
}
