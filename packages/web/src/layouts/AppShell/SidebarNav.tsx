import { NavLink } from "react-router-dom";
import {
  MessageOutlined,
  FolderOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import "./SidebarNav.css";

const navItems = [
  { to: "/chat", label: "对话", icon: <MessageOutlined /> },
  { to: "/runs", label: "项目", icon: <FolderOutlined /> },
  { to: "/artifacts", label: "知识库", icon: <DatabaseOutlined /> },
  { to: "/memory", label: "记忆", icon: <HistoryOutlined /> },
  { to: "/settings", label: "设置", icon: <SettingOutlined /> },
];

export function SidebarNav({ activeConversationId: _activeConversationId }: { activeConversationId: string }) {
  return (
    <nav className="sidebar-nav" aria-label="主导航">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            `nav-item${isActive ? " active" : ""}`
          }
        >
          {item.icon}
          <span className="sidebar-label">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
