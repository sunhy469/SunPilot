import { Drawer, Input, Button, List } from "antd";
import { useState, useMemo } from "react";
import "./BeingChatPanel.scss";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface BeingChatPanelProps {
  open: boolean;
  beingName?: string;
  onClose: () => void;
}

export function BeingChatPanel({ open, beingName, onClose }: BeingChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");

  const handleSend = () => {
    if (!input.trim()) return;
    const userMsg: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: input.trim(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");

    // Phase 6: placeholder response
    setTimeout(() => {
      const assistantMsg: ChatMessage = {
        id: `msg_${Date.now()}_resp`,
        role: "assistant",
        content: "收到指令，正在处理...",
      };
      setMessages((prev) => [...prev, assistantMsg]);
    }, 500);
  };

  return (
    <Drawer title={`与 ${beingName ?? "数字生命"} 对话`} open={open} onClose={onClose} width={360}>
      <div className="being-chat-panel">
        <div className="being-chat-panel__messages">
          {messages.length === 0 && (
            <div className="being-chat-panel__empty">发送消息与数字生命对话</div>
          )}
          <List
            dataSource={messages}
            renderItem={(msg) => (
              <div className={`being-chat-panel__msg being-chat-panel__msg--${msg.role}`}>
                {msg.content}
              </div>
            )}
          />
        </div>
        <div className="being-chat-panel__input">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPressEnter={handleSend}
            placeholder="输入消息..."
          />
          <Button type="primary" onClick={handleSend}>
            发送
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
