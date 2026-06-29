import { useState } from "react";
import { Typography, Button, Dropdown, Modal, Input, Popover, Badge, Tooltip, App } from "antd";
import {
  MoreOutlined,
  EditOutlined,
  PushpinOutlined,
  FolderOpenOutlined,
} from "@ant-design/icons";
import type { Conversation } from "../../../../features/conversations/types";
import type { AiOutputItem } from "../../utils/collectAiOutputs";
import { OutputsPopover } from "../OutputsPopover/OutputsPopover";
import "./ChatHeader.scss";

const { Text } = Typography;

export interface ChatHeaderProps {
  title: string;
  conversation?: Conversation;
  showConversationActions?: boolean;
  onRename?: (id: string, title: string) => void | Promise<void>;
  onTogglePin?: (id: string, pinned: boolean) => void | Promise<void>;
  outputCount?: number;
  outputs?: AiOutputItem[];
}

export function ChatHeader({
  title,
  conversation,
  showConversationActions,
  onRename,
  onTogglePin,
  outputCount = 0,
  outputs = [],
}: ChatHeaderProps) {
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const { message } = App.useApp();

  const handleRenameOpen = () => {
    if (conversation) {
      setRenameValue(conversation.title || "");
      setRenameModalOpen(true);
    }
  };

  const handleRenameOk = async () => {
    if (conversation && renameValue.trim() && onRename) {
      try {
        await onRename(conversation.id, renameValue.trim());
      } catch (error) {
        message.error(
          `重命名失败：${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
    }
    setRenameModalOpen(false);
    setRenameValue("");
  };

  const handleRenameCancel = () => {
    setRenameModalOpen(false);
    setRenameValue("");
  };

  const menuItems = conversation
    ? [
        {
          key: "pin",
          icon: <PushpinOutlined />,
          label: conversation.pinned ? "取消置顶" : "置顶",
          onClick: () => {
            if (onTogglePin) {
              void onTogglePin(conversation.id, !conversation.pinned);
            }
          },
        },
        {
          key: "rename",
          icon: <EditOutlined />,
          label: "重命名",
          onClick: handleRenameOpen,
        },
      ]
    : [];

  return (
    <div className="chat-header">
      <div className="chat-header__main">
        <Text strong className="chat-header__title" title={title}>
          {title || "SunPilot"}
        </Text>
        {showConversationActions && conversation && menuItems.length > 0 && (
          <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomLeft">
            <Button
              type="text"
              size="small"
              className="chat-header__more-btn"
              icon={<MoreOutlined />}
              aria-label="对话操作"
            />
          </Dropdown>
        )}
      </div>
      {showConversationActions && (
        <div className="chat-header__actions">
          <Popover
            trigger="click"
            placement="bottomRight"
            arrow={false}
            content={<OutputsPopover outputs={outputs} />}
          >
            <Tooltip title="产物">
              <Badge count={outputCount} size="small" offset={[-2, 4]}>
                <Button
                  type="text"
                  size="small"
                  className="chat-header__outputs-btn"
                  icon={<FolderOpenOutlined />}
                  aria-label="查看产物"
                />
              </Badge>
            </Tooltip>
          </Popover>
        </div>
      )}
      <Modal
        title="重命名会话"
        open={renameModalOpen}
        onOk={handleRenameOk}
        onCancel={handleRenameCancel}
        okText="确定"
        cancelText="取消"
        destroyOnHidden
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
    </div>
  );
}
