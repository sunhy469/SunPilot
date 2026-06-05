import { AppstoreOutlined } from "@ant-design/icons";
import "./SidebarNav.css";

export function SidebarNav({
  active,
  onOpenPlugins,
}: {
  active: boolean;
  onOpenPlugins: () => void;
}) {
  return (
    <nav className="sidebar-nav" aria-label="主导航">
      <button
        type="button"
        aria-label="插件"
        className={`nav-item${active ? " active" : ""}`}
        onClick={onOpenPlugins}
      >
        <AppstoreOutlined />
        <span className="sidebar-label">插件</span>
      </button>
    </nav>
  );
}
