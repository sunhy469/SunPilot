import { AppstoreOutlined } from "@ant-design/icons";
import { Button } from "antd";
import "./SidebarNav.css";

export function SidebarNav({
  active,
  onOpenPlugins,
}: {
  active: boolean;
  onOpenPlugins: () => void;
}) {
  return (
    <div className="sidebar-nav">
      <Button
        type={active ? "primary" : "text"}
        icon={<AppstoreOutlined />}
        aria-label="插件"
        block
        onClick={onOpenPlugins}
      >
        插件
      </Button>
    </div>
  );
}
