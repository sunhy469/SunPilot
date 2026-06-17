import { Typography, Flex, Button } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import "./UserFooter.css";

const { Text } = Typography;

export function UserFooter({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <Flex className="user-footer" align="center">
      <Button
        type="text"
        size="large"
        icon={<SettingOutlined />}
        className="user-footer-btn"
        onClick={onOpenSettings}
      >
        <Text>设置</Text>
      </Button>
    </Flex>
  );
}
