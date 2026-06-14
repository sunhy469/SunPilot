import { Avatar, Typography, Space, Flex } from "antd";
import { UserOutlined } from "@ant-design/icons";
import "./UserFooter.css";

const { Text } = Typography;

export function UserFooter() {
  return (
    <Flex className="user-footer" align="center">
      <Space>
        <Avatar size="small" icon={<UserOutlined />} style={{ backgroundColor: "#2563eb" }}>
          张
        </Avatar>
        <Text>张伟</Text>
      </Space>
    </Flex>
  );
}
