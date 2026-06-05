import { DownOutlined, MoreOutlined } from "@ant-design/icons";
import "./ChatHeader.css";

export function ChatHeader({ title }: { title: string }) {
  return (
    <header className="chat-header">
      <div className="chat-title">
        <span className="chat-title-text">{title}</span>
        <DownOutlined className="chat-title-arrow" />
      </div>
      <button
        type="button"
        className="chat-header-more sp-icon-button sp-icon-button--md sp-icon-button--warm"
        aria-label="更多操作"
      >
        <MoreOutlined />
      </button>
    </header>
  );
}
