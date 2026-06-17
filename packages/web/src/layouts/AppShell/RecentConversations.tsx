import { useState, useMemo } from "react";
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
      <Text type="secondary">{label}</Text>
      {expanded ? (
        <DownOutlined style={{ fontSize: 10, color: "var(--sp-muted)" }} />
      ) : (
        <RightOutlined style={{ fontSize: 10, color: "var(--sp-muted)" }} />
      )}
    </Flex>
  );
}

// ── Time-group helpers ──────────────────────────────────────────────────

type TimeGroup = "today" | "yesterday" | "thisWeek" | "earlier";

function getTimeGroupLabel(g: TimeGroup): string {
  switch (g) {
    case "today":     return "今天";
    case "yesterday": return "昨天";
    case "thisWeek":  return "本周";
    case "earlier":   return "更早";
  }
}

function classifyByTime(convs: Conversation[]): Map<TimeGroup, Conversation[]> {
  const now = Date.now();
  const startOfToday = new Date(new Date().toDateString()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - 6 * 86400000;

  const groups = new Map<TimeGroup, Conversation[]>();
  groups.set("today", []);
  groups.set("yesterday", []);
  groups.set("thisWeek", []);
  groups.set("earlier", []);

  for (const conv of convs) {
    const ts = new Date(conv.createdAt).getTime();
    if (ts >= startOfToday) {
      groups.get("today")!.push(conv);
    } else if (ts >= startOfYesterday) {
      groups.get("yesterday")!.push(conv);
    } else if (ts >= startOfWeek) {
      groups.get("thisWeek")!.push(conv);
    } else {
      groups.get("earlier")!.push(conv);
    }
  }

  return groups;
}

// ── Component ───────────────────────────────────────────────────────────

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

  const chatTimeGroups = useMemo(
    () => classifyByTime(chatConversations),
    [chatConversations],
  );

  if (projectConversations.length === 0 && chatConversations.length === 0) {
    return null;
  }

  const renderConv = (conv: Conversation) => (
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
  );

  return (
    <Flex vertical className="recent-section">
      {/* ── 项目 ────────────────────────────────────────────────── */}
      {projectConversations.length > 0 && (
        <>
          <SectionHeader
            label="项目"
            expanded={projectsExpanded}
            onToggle={() => setProjectsExpanded((v) => !v)}
          />
          {projectsExpanded &&
            projectConversations.slice(0, 10).map(renderConv)}
        </>
      )}

      {/* ── 对话 (grouped by time) ──────────────────────────────── */}
      {chatConversations.length > 0 && (
        <>
          <SectionHeader
            label="对话"
            expanded={chatsExpanded}
            onToggle={() => setChatsExpanded((v) => !v)}
          />
          {chatsExpanded &&
            Array.from(chatTimeGroups.entries()).map(([group, convs]) => {
              if (convs.length === 0) return null;
              return (
                <Flex key={group} vertical gap={0} className="recent-time-group">
                  <Text className="recent-time-group__label">
                    {getTimeGroupLabel(group as TimeGroup)}
                  </Text>
                  {convs.map(renderConv)}
                </Flex>
              );
            })}
        </>
      )}
    </Flex>
  );
}
