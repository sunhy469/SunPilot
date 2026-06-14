import { AppstoreOutlined, PlusOutlined } from "@ant-design/icons";
import { Button, Flex } from "antd";
import "./SidebarNav.css";

export function SidebarNav({
  active,
  onNewChat,
  onOpenPlugins,
}: {
  active: boolean;
  onNewChat: () => void;
  onOpenPlugins: () => void;
}) {
  return (
    <Flex vertical gap={4} className="sidebar-nav">
      <Button
        type="text"
        size="small"
        icon={<PlusOutlined />}
        onClick={onNewChat}
      >
        新对话
      </Button>
      <Button
        type={active ? "primary" : "text"}
        size="small"
        icon={<AppstoreOutlined />}
        onClick={onOpenPlugins}
      >
        插件
      </Button>
    </Flex>
  );
}
