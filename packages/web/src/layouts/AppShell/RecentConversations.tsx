import type { Conversation } from "../../features/conversations/types";
import "./RecentConversations.css";

export function RecentConversations({
  conversations,
  activeConversationId,
  onSelect,
  conversationTitle,
}: {
  conversations: Conversation[];
  activeConversationId: string;
  onSelect: (id: string) => void;
  conversationTitle: (title: string | undefined) => string;
}) {
  if (conversations.length === 0) return null;

  return (
    <div className="recent-section">
      <div className="recent-title">最近对话</div>
      {conversations.slice(0, 10).map((conv) => (
        <button
          key={conv.id}
          type="button"
          className={`recent-item${conv.id === activeConversationId ? " is-active" : ""}`}
          title={conversationTitle(conv.title)}
          onClick={() => onSelect(conv.id)}
        >
          {conversationTitle(conv.title)}
        </button>
      ))}
    </div>
  );
}
