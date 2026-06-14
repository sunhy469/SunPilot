import { Typography, Button, Space } from "antd";
import { DownOutlined, MoreOutlined } from "@ant-design/icons";
import "./ChatHeader.css";

const { Text } = Typography;

export function ChatHeader({ title }: { title: string }) {
  return (
    <div className="chat-header">
      <Space className="chat-title">
        <Text strong>{title}</Text>
        <DownOutlined className="chat-title-arrow" />
      </Space>
      <Button
        type="text"
        icon={<MoreOutlined />}
        aria-label="设置"
        size="small"
      />
    </div>
  );
}
