import { Button, Tooltip } from "antd";
import {
  InfoCircleOutlined,
  InboxOutlined,
  MessageOutlined,
  UnorderedListOutlined,
  FileTextOutlined,
  SettingOutlined,
  MoonOutlined,
  SunOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";
import "./WorldFloatingDock.scss";

interface DockItem {
  key: string;
  icon: ReactNode;
  label: string;
}

const dockItems: DockItem[] = [
  { key: "status", icon: <InfoCircleOutlined />, label: "状态" },
  { key: "artifacts", icon: <InboxOutlined />, label: "产物" },
  { key: "chat", icon: <MessageOutlined />, label: "对话" },
  { key: "tasks", icon: <UnorderedListOutlined />, label: "任务" },
  { key: "logs", icon: <FileTextOutlined />, label: "日志" },
  { key: "settings", icon: <SettingOutlined />, label: "设置" },
  // §9.4.1: wake/sleep icon is swapped dynamically based on beingStatus.
  { key: "wake-sleep", icon: <MoonOutlined />, label: "唤醒/休眠" },
];

interface WorldFloatingDockProps {
  onAction?: (key: string) => void;
  /** §9.4.1: key of the currently open panel — shows a dot indicator on it. */
  activePanel?: string;
  /** §9.4.1: being status — drives the wake/sleep button icon + color. */
  beingStatus?: string;
}

export function WorldFloatingDock({ onAction, activePanel, beingStatus }: WorldFloatingDockProps) {
  const isSleeping = beingStatus === "sleeping";

  return (
    <div className="world-floating-dock">
      {dockItems.map((item) => {
        // §9.4.1: swap the wake/sleep icon based on the being's status.
        // Sleeping → sun (click to wake); awake → moon (click to sleep).
        let icon = item.icon;
        let statusClass = "";
        if (item.key === "wake-sleep") {
          icon = isSleeping ? <SunOutlined /> : <MoonOutlined />;
          statusClass = isSleeping ? "world-floating-dock__btn--sleeping" : "world-floating-dock__btn--awake";
        }

        const isActive = activePanel != null && activePanel === item.key;
        const className = [
          "world-floating-dock__btn",
          isActive ? "world-floating-dock__btn--active" : "",
          statusClass,
        ]
          .filter(Boolean)
          .join(" ");

        return (
          <Tooltip key={item.key} title={item.label} placement="left">
            <Button
              className={className}
              type="text"
              icon={icon}
              onClick={() => onAction?.(item.key)}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}
