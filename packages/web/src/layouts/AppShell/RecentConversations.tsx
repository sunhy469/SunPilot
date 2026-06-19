import { useState, useMemo } from "react";
import type { Conversation } from "../../features/conversations/types";
import { Button, Typography, Flex, Dropdown, Modal, Input, App } from "antd";
import {
  RightOutlined,
  DownOutlined,
  MoreOutlined,
  EditOutlined,
  PushpinOutlined,
  PushpinFilled,
  DeleteOutlined,
} from "@ant-design/icons";
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
    <Flex align="center" gap={4} className="recent-title" onClick={onToggle}>
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

type TimeGroup = "pinned" | "today" | "yesterday" | "thisWeek" | "earlier";

function getTimeGroupLabel(g: TimeGroup): string {
  switch (g) {
    case "pinned":
      return "置顶";
    case "today":
      return "今天";
    case "yesterday":
      return "昨天";
    case "thisWeek":
      return "本周";
    case "earlier":
      return "更早";
  }
}

function classifyByTime(convs: Conversation[]): Map<TimeGroup, Conversation[]> {
  const startOfToday = new Date(new Date().toDateString()).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfWeek = startOfToday - 6 * 86400000;

  const groups = new Map<TimeGroup, Conversation[]>();
  groups.set("pinned", []);
  groups.set("today", []);
  groups.set("yesterday", []);
  groups.set("thisWeek", []);
  groups.set("earlier", []);

  for (const conv of convs) {
    // Pinned conversations go to the "pinned" group only (not duplicated in time groups)
    if (conv.pinned) {
      groups.get("pinned")!.push(conv);
      continue;
    }
    // Use updatedAt (not createdAt) for time-based grouping
    const ts = new Date(conv.updatedAt).getTime();
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
  onRename,
  onDelete,
  onTogglePin,
}: {
  projectConversations: Conversation[];
  chatConversations: Conversation[];
  activeConversationId: string;
  active: boolean;
  onSelect: (id: string) => void;
  conversationTitle: (title: string | undefined) => string;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void | Promise<void>;
  onTogglePin: (id: string, pinned: boolean) => void;
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [chatsExpanded, setChatsExpanded] = useState(true);

  // Rename modal state
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const { modal } = App.useApp();

  const chatTimeGroups = useMemo(
    () => classifyByTime(chatConversations),
    [chatConversations],
  );

  if (projectConversations.length === 0 && chatConversations.length === 0) {
    return null;
  }

  const handleRenameOpen = (conv: Conversation) => {
    setRenameTarget(conv);
    setRenameValue(conversationTitle(conv.title));
  };

  const handleRenameOk = () => {
    if (renameTarget && renameValue.trim()) {
      onRename(renameTarget.id, renameValue.trim());
    }
    setRenameTarget(null);
    setRenameValue("");
  };

  const handleDeleteClick = (conv: Conversation) => {
    modal.confirm({
      title: "删除会话",
      content: `确定要删除会话"${conversationTitle(conv.title) || "未命名"}"吗？此操作不可撤销。`,
      okText: "删除",
      okType: "danger",
      cancelText: "取消",
      onOk: async () => {
        await onDelete(conv.id);
      },
    });
  };

  const renderConv = (conv: Conversation) => {
    const isActive = active && conv.id === activeConversationId;
    const title = conversationTitle(conv.title) || "未命名";

    const menuItems = [
      {
        key: "rename",
        icon: <EditOutlined />,
        label: "重命名",
        onClick: () => handleRenameOpen(conv),
      },
      {
        key: "pin",
        icon: <PushpinOutlined />,
        label: conv.pinned ? "取消置顶" : "置顶",
        onClick: () => onTogglePin(conv.id, !conv.pinned),
      },
      {
        key: "delete",
        icon: <DeleteOutlined style={{ color: "#ff4d4f" }} />,
        label: <span style={{ color: "#ff4d4f" }}>删除</span>,
        onClick: () => handleDeleteClick(conv),
      },
    ];

    return (
      <Flex
        key={conv.id}
        justify="space-between"
        align="center"
        className={`recent-item-wrap${isActive ? " recent-item-wrap--active" : ""}`}
      >
        <Button
          type="text"
          size="small"
          className={`recent-item${isActive ? " recent-item--active" : ""}`}
          title={title}
          onClick={() => onSelect(conv.id)}
          style={{ flex: 1, justifyContent: "flex-start", overflow: "hidden" }}
        >
          {conv.pinned && <PushpinFilled className="recent-item__pin" />}
          <span className="recent-item__label">{title}</span>
        </Button>
        <Dropdown
          menu={{ items: menuItems }}
          trigger={["click"]}
          placement="bottomRight"
        >
          <Button
            type="text"
            size="small"
            className="recent-item__more-btn"
            icon={<MoreOutlined />}
            onClick={(e) => e.stopPropagation()}
          />
        </Dropdown>
      </Flex>
    );
  };

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
                <Flex
                  key={group}
                  vertical
                  gap={0}
                  className="recent-time-group"
                >
                  <Text className="recent-time-group__label">
                    {getTimeGroupLabel(group as TimeGroup)}
                  </Text>
                  {convs.map(renderConv)}
                </Flex>
              );
            })}
        </>
      )}

      {/* ── Rename modal ────────────────────────────────────────── */}
      <Modal
        title="重命名会话"
        open={renameTarget !== null}
        onOk={handleRenameOk}
        onCancel={() => {
          setRenameTarget(null);
          setRenameValue("");
        }}
        okText="确定"
        cancelText="取消"
        destroyOnClose
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder="输入新名称"
          onPressEnter={handleRenameOk}
          maxLength={200}
          autoFocus
        />
      </Modal>
    </Flex>
  );
}
