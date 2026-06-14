import { Typography, Flex, Button } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import "./UserFooter.css";

const { Text } = Typography;

export function UserFooter() {
  return (
    <Flex className="user-footer" align="center">
      <Button
        type="text"
        size="small"
        icon={<SettingOutlined />}
        className="user-footer-btn"
      >
        <Text>设置</Text>
      </Button>
    </Flex>
  );
}
