import type { Conversation } from "../../features/conversations/types";
import { Button, Typography } from "antd";
import { MessageOutlined } from "@ant-design/icons";
import "./RecentConversations.css";

const { Text } = Typography;

export function RecentConversations({
  conversations,
  activeConversationId,
  active,
  onSelect,
  conversationTitle,
}: {
  conversations: Conversation[];
  activeConversationId: string;
  active: boolean;
  onSelect: (id: string) => void;
  conversationTitle: (title: string | undefined) => string;
}) {
  if (conversations.length === 0) return null;

  return (
    <div className="recent-section">
      <Text type="secondary" className="recent-title">最近对话</Text>
      {conversations.slice(0, 10).map((conv) => (
        <Button
          key={conv.id}
          type={active && conv.id === activeConversationId ? "primary" : "text"}
          size="small"
          block
          icon={<MessageOutlined />}
          className="recent-item"
          title={conversationTitle(conv.title)}
          onClick={() => onSelect(conv.id)}
        >
          {conversationTitle(conv.title)}
        </Button>
      ))}
    </div>
  );
}
