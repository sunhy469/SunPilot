import { Button, Tooltip } from "antd";
import {
  InfoCircleOutlined,
  InboxOutlined,
  MessageOutlined,
  UnorderedListOutlined,
  FileTextOutlined,
  SettingOutlined,
  PoweroffOutlined,
} from "@ant-design/icons";
import "./WorldFloatingDock.scss";

const dockItems = [
  { key: "status", icon: <InfoCircleOutlined />, label: "状态" },
  { key: "artifacts", icon: <InboxOutlined />, label: "产物" },
  { key: "chat", icon: <MessageOutlined />, label: "对话" },
  { key: "tasks", icon: <UnorderedListOutlined />, label: "任务" },
  { key: "logs", icon: <FileTextOutlined />, label: "日志" },
  { key: "settings", icon: <SettingOutlined />, label: "设置" },
  { key: "wake-sleep", icon: <PoweroffOutlined />, label: "唤醒/休眠" },
];

interface WorldFloatingDockProps {
  onAction?: (key: string) => void;
}

export function WorldFloatingDock({ onAction }: WorldFloatingDockProps) {
  return (
    <div className="world-floating-dock">
      {dockItems.map((item) => (
        <Tooltip key={item.key} title={item.label} placement="left">
          <Button
            className="world-floating-dock__btn"
            type="text"
            icon={item.icon}
            onClick={() => onAction?.(item.key)}
          />
        </Tooltip>
      ))}
    </div>
  );
}
