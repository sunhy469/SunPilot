import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "../../features/conversations/types";
import { conversationTitle } from "../../features/conversations/model";
import { SidebarNav } from "./SidebarNav";
import { RecentConversations } from "./RecentConversations";
import { UserFooter } from "./UserFooter";
import { Layout } from "antd";
import "./Sidebar.css";

const { Sider } = Layout;

const MIN_WIDTH = 200;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 260;

export function Sidebar({
  conversations,
  activeConversationId,
  activePanel,
  onNewChat,
  onSelect,
  onOpenPlugins,
}: {
  conversations: Conversation[];
  activeConversationId: string;
  activePanel: "chat" | "plugins";
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onOpenPlugins: () => void;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_WIDTH);
  const siderRef = useRef<HTMLElement>(null);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(DEFAULT_WIDTH);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = sidebarWidth;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [sidebarWidth],
  );

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!draggingRef.current) return;
    const delta = e.clientX - startXRef.current;
    const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidthRef.current + delta));
    // Direct DOM manipulation for smooth drag — bypass React render cycle
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
    // Sync final width to React state
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
      className="sidebar"
      width={sidebarWidth}
      collapsedWidth={72}
      collapsible
      trigger={null}
      defaultCollapsed={false}
      style={{ minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
    >
      <div className="sidebar-inner">
        <SidebarNav
          active={activePanel === "plugins"}
          onNewChat={onNewChat}
          onOpenPlugins={onOpenPlugins}
        />

        <RecentConversations
          projectConversations={projectConversations}
          chatConversations={chatConversations}
          activeConversationId={activeConversationId}
          active={activePanel === "chat"}
          onSelect={onSelect}
          conversationTitle={conversationTitle}
        />

        <UserFooter />
      </div>

      {/* Resize handle */}
      <div
        className="sidebar-resize-handle"
        onMouseDown={handleMouseDown}
      />
    </Sider>
  );
}
