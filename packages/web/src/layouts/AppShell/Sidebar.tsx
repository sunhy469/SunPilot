import type { Conversation } from "../../features/conversations/types";
import { conversationTitle } from "../../features/conversations/model";
import { SidebarNav } from "./SidebarNav";
import { RecentConversations } from "./RecentConversations";
import { UserFooter } from "./UserFooter";
import "./Sidebar.css";

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
  return (
    <aside className="sidebar">
      <div className="logo-row">
        <img className="logo-mark" src="/logo.png" alt="SunPilot logo" />
        <span className="logo-text">SunPilot</span>
      </div>

      <button
        className="new-chat-button sp-button sp-button--accent sp-button--block sp-button--lg"
        type="button"
        onClick={onNewChat}
      >
        + 新建对话
      </button>

      <SidebarNav
        active={activePanel === "plugins"}
        onOpenPlugins={onOpenPlugins}
      />

      <RecentConversations
        conversations={conversations}
        activeConversationId={activeConversationId}
        active={activePanel === "chat"}
        onSelect={onSelect}
        conversationTitle={conversationTitle}
      />

      <UserFooter />
    </aside>
  );
}
