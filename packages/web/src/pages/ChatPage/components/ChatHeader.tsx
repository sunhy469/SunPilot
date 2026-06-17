import { Typography } from "antd";
import "./ChatHeader.css";

const { Text } = Typography;

export function ChatHeader({ title }: { title: string }) {
  return (
    <div className="chat-header">
      <Text strong className="chat-header__title">{title || "SunPilot"}</Text>
    </div>
  );
}
