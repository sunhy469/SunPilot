import type { Conversation } from "../../features/conversations/types";
import { conversationTitle } from "../../features/conversations/model";
import { SidebarNav } from "./SidebarNav";
import { RecentConversations } from "./RecentConversations";
import { UserFooter } from "./UserFooter";
import "./Sidebar.css";

export function Sidebar({
  conversations,
  activeConversationId,
  onNewChat,
  onSelect,
}: {
  conversations: Conversation[];
  activeConversationId: string;
  onNewChat: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="logo-row">
        <div className="logo-mark">SP</div>
        <span className="logo-text">SunPilot</span>
      </div>

      <button
        className="new-chat-button sp-button sp-button--accent sp-button--block sp-button--lg"
        type="button"
        onClick={onNewChat}
      >
        + 新建对话
      </button>

      <SidebarNav activeConversationId={activeConversationId} />

      <RecentConversations
        conversations={conversations}
        activeConversationId={activeConversationId}
        onSelect={onSelect}
        conversationTitle={conversationTitle}
      />

      <UserFooter />
    </aside>
  );
}
