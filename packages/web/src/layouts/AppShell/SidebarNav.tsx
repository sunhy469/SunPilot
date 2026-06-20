import { AppstoreOutlined, BugOutlined, PlusOutlined } from "@ant-design/icons";
import { DigitalBeingIcon } from "../../shared/components/DigitalBeingIcon";
import { Button, Flex } from "antd";
import "./SidebarNav.scss";

export function SidebarNav({
  activePanel,
  onNewChat,
  onOpenAutomation,
  onOpenPlugins,
  onOpenDebug,
}: {
  activePanel: "chat" | "automation" | "plugins" | "debug" | "settings";
  onNewChat: () => void;
  onOpenAutomation: () => void;
  onOpenPlugins: () => void;
  onOpenDebug: () => void;
}) {
  return (
    <Flex vertical gap={2} className="sidebar-nav">
      <Button
        type="text"
        size="large"
        icon={<PlusOutlined />}
        className={`sidebar-nav-item${activePanel === "chat" ? " sidebar-nav-item--active" : ""}`}
        onClick={onNewChat}
      >
        新对话
      </Button>
      <Button
        type="text"
        size="large"
        icon={<AppstoreOutlined />}
        className={`sidebar-nav-item${activePanel === "plugins" ? " sidebar-nav-item--active" : ""}`}
        onClick={onOpenPlugins}
      >
        插件
      </Button>
      <Button
        type="text"
        size="large"
        icon={<DigitalBeingIcon />}
        className={`sidebar-nav-item${activePanel === "automation" ? " sidebar-nav-item--active" : ""}`}
        onClick={onOpenAutomation}
      >
        数字生命
      </Button>
      <Button
        type="text"
        size="large"
        icon={<BugOutlined />}
        className={`sidebar-nav-item${activePanel === "debug" ? " sidebar-nav-item--active" : ""}`}
        onClick={onOpenDebug}
      >
        Debug
      </Button>
    </Flex>
  );
}
