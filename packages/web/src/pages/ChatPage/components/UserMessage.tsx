import type { ChatMessage } from "../../../features/conversations/types";
import { formatTime } from "../../../shared/utils/formatTime";
import "./UserMessage.css";

export function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="message-row user">
      <div className="user-bubble">
        <p>{message.content}</p>
      </div>
      <div className="user-avatar">You</div>
      {message.createdAt && (
        <span className="message-time">{formatTime(message.createdAt)}</span>
      )}
    </div>
  );
}
