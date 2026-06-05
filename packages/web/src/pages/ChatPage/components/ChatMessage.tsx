import { Avatar } from "antd";
import { UserOutlined } from "@ant-design/icons";
import type { ChatMessage as ChatMessageType } from "../../../features/conversations/types";
import { assistantDisplayName } from "../../../features/chat/model";
import { formatTime } from "../../../shared/utils/formatTime";

export function ChatMessage({ message }: { message: ChatMessageType }) {
  const assistant = message.role === "assistant";
  return (
    <article className={`chat-message chat-message--${message.role}`}>
      <Avatar icon={assistant ? undefined : <UserOutlined />} className="chat-message__avatar">{assistant ? "S" : undefined}</Avatar>
      <div className="chat-message__body">
        <div className="chat-message__meta">
          <strong>{assistant ? assistantDisplayName : "You"}</strong>
          <span>{formatTime(message.createdAt)}</span>
        </div>
        <p>{message.content}</p>
      </div>
    </article>
  );
}
