import { Button, Input, Typography } from "antd";
import { Link } from "react-router-dom";
import { PlusOutlined, SearchOutlined } from "@ant-design/icons";
import type { Conversation } from "../../../features/conversations/types";
import { conversationTitle } from "../../../features/conversations/model";

export function ChatSidebar({
  conversations,
  activeConversationId,
  onNewChat,
  onSelect
}: {
  conversations: Conversation[];
  activeConversationId: string;
  onNewChat: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="chat-sidebar">
      <div className="chat-sidebar__brand">
        <Typography.Title level={3}>SunPilot</Typography.Title>
      </div>
      <Button aria-label="New Chat" type="primary" block icon={<PlusOutlined />} onClick={onNewChat} />
      <Input aria-label="Search" prefix={<SearchOutlined />} allowClear />
      <div className="chat-sidebar__list">
        {conversations.map((conversation) => (
          <button
            className={conversation.id === activeConversationId ? "is-active" : ""}
            key={conversation.id}
            onClick={() => onSelect(conversation.id)}
            type="button"
          >
            <Typography.Text ellipsis>{conversationTitle(conversation.title)}</Typography.Text>
          </button>
        ))}
      </div>
      <nav className="chat-sidebar__nav" aria-label="Workspace">
        <Link to="/runs">Runs</Link>
        <Link to="/artifacts">Artifacts</Link>
        <Link to="/memory">Memory</Link>
        <Link to="/settings">Settings</Link>
      </nav>
    </aside>
  );
}
