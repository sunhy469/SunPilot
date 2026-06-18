import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "../../features/conversations/types";
import { conversationTitle } from "../../features/conversations/model";
import { SidebarNav } from "./SidebarNav";
import { RecentConversations } from "./RecentConversations";
import { UserFooter } from "./UserFooter";
import { useResponsive } from "../../shared/hooks/useResponsive";
import { Layout } from "antd";
import "./Sidebar.css";

const { Sider } = Layout;

const MIN_WIDTH = 240;
const MAX_WIDTH = 520;
const DEFAULT_WIDTH = 300;
const COLLAPSED_ICON_WIDTH = 80;

export function Sidebar({
  conversations,
  activeConversationId,
  activePanel,
  onNewChat,
  onSelect,
  onOpenAutomation,
  onOpenPlugins,
  onOpenDebug,
  onOpenSettings,
  onRename,
  onDeleteConversation,
  onTogglePin,
}: {
  conversations: Conversation[];
  activeConversationId: string;
  activePanel: "chat" | "automation" | "plugins" | "debug" | "settings";
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onOpenAutomation: () => void;
  onOpenPlugins: () => void;
  onOpenDebug: () => void;
  onOpenSettings: () => void;
  onRename: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void | Promise<void>;
  onTogglePin: (id: string, pinned: boolean) => void;
}) {
  const responsive = useResponsive();
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const siderRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(DEFAULT_WIDTH);

  // Auto-collapse on tablet/mobile — icon-only mode on compact screens
  const collapsed = responsive.isCompact;
  const collapsedWidth = responsive.isMobile ? 0 : COLLAPSED_ICON_WIDTH;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (responsive.isCompact) return; // no resize on mobile
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth, responsive.isCompact],
  );

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingRef.current) return;
    const delta = e.clientX - startXRef.current;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
    if (siderRef.current) {
      siderRef.current.style.width = `${next}px`;
      siderRef.current.style.minWidth = `${next}px`;
      siderRef.current.style.maxWidth = `${next}px`;
      siderRef.current.style.flex = `0 0 ${next}px`;
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (siderRef.current) {
      const finalWidth = parseInt(siderRef.current.style.width, 10) || DEFAULT_WIDTH;
      setSidebarWidth(finalWidth);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  const chatConversations = conversations.filter(
    (c) => c.kind === "chat" || c.kind === undefined,
  );
  const projectConversations = conversations.filter(
    (c) => c.kind === "project",
  );

  return (
    <Sider
      ref={siderRef}
      className={`sidebar${collapsed ? " sidebar--collapsed" : ""}${responsive.isMobile ? " sidebar--mobile" : ""}`}
      width={sidebarWidth}
      collapsedWidth={collapsedWidth}
      collapsible
      collapsed={collapsed}
      trigger={null}
      defaultCollapsed={false}
      style={{
        minWidth: responsive.isMobile ? 0 : MIN_WIDTH,
        maxWidth: MAX_WIDTH,
      }}
    >
      <div className="sidebar-inner">
        <SidebarNav
          activePanel={activePanel}
          onNewChat={onNewChat}
          onOpenAutomation={onOpenAutomation}
          onOpenPlugins={onOpenPlugins}
          onOpenDebug={onOpenDebug}
        />

        <RecentConversations
          projectConversations={projectConversations}
          chatConversations={chatConversations}
          activeConversationId={activeConversationId}
          active={activePanel === "chat"}
          onSelect={onSelect}
          conversationTitle={conversationTitle}
          onRename={onRename}
          onDelete={onDeleteConversation}
          onTogglePin={onTogglePin}
        />

        <UserFooter onOpenSettings={onOpenSettings} />
      </div>

      {/* Resize handle — hidden on mobile */}
      {!responsive.isCompact && (
        <div
          className="sidebar-resize-handle"
          onMouseDown={handleMouseDown}
        />
      )}
    </Sider>
  );
}
