import { useState } from "react";
import type { Conversation } from "../../features/conversations/types";
import { Button, Typography, Flex } from "antd";
import { RightOutlined, DownOutlined } from "@ant-design/icons";
import "./RecentConversations.css";

const { Text } = Typography;

function SectionHeader({
  label,
  expanded,
  onToggle,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <Flex
      align="center"
      gap={4}
      className="recent-title"
      onClick={onToggle}
    >
      <Text type="secondary">
        {label}
      </Text>
      {expanded ? (
        <DownOutlined style={{ fontSize: 10, color: "var(--sp-muted)" }} />
      ) : (
        <RightOutlined style={{ fontSize: 10, color: "var(--sp-muted)" }} />
      )}
    </Flex>
  );
}

export function RecentConversations({
  projectConversations,
  chatConversations,
  activeConversationId,
  active,
  onSelect,
  conversationTitle,
}: {
  projectConversations: Conversation[];
  chatConversations: Conversation[];
  activeConversationId: string;
  active: boolean;
  onSelect: (id: string) => void;
  conversationTitle: (title: string | undefined) => string;
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [chatsExpanded, setChatsExpanded] = useState(true);

  if (projectConversations.length === 0 && chatConversations.length === 0) {
    return null;
  }

  return (
    <div className="recent-section">
      {/* ── 项目 ────────────────────────────────────────────────── */}
      <SectionHeader
        label="项目"
        expanded={projectsExpanded}
        onToggle={() => setProjectsExpanded((v) => !v)}
      />
      {projectsExpanded &&
        projectConversations.slice(0, 10).map((conv) => (
          <Button
            key={conv.id}
            type="text"
            size="small"
            block
            className={`recent-item${active && conv.id === activeConversationId ? " recent-item--active" : ""}`}
            title={conversationTitle(conv.title)}
            onClick={() => onSelect(conv.id)}
          >
            {conversationTitle(conv.title)}
          </Button>
        ))}

      {/* ── 对话 ────────────────────────────────────────────────── */}
      <SectionHeader
        label="对话"
        expanded={chatsExpanded}
        onToggle={() => setChatsExpanded((v) => !v)}
      />
      {chatsExpanded &&
        chatConversations.slice(0, 10).map((conv) => (
          <Button
            key={conv.id}
            type="text"
            size="small"
            block
            className={`recent-item${active && conv.id === activeConversationId ? " recent-item--active" : ""}`}
            title={conversationTitle(conv.title)}
            onClick={() => onSelect(conv.id)}
          >
            {conversationTitle(conv.title)}
          </Button>
        ))}
    </div>
  );
}
