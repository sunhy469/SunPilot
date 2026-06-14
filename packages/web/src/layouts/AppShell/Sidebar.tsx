import type { Conversation } from "../../features/conversations/types";
import { conversationTitle } from "../../features/conversations/model";
import { SidebarNav } from "./SidebarNav";
import { RecentConversations } from "./RecentConversations";
import { UserFooter } from "./UserFooter";
import { Layout, Button, Typography, Image } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import "./Sidebar.css";

const { Sider } = Layout;
const { Text } = Typography;

export function Sidebar({
  conversations,
  activeConversationId,
  activePanel,
  onNewChat,
  onSelect,
  onOpenPlugins,
}: {
  conversations: Conversation[];
  activeConversationId: string;
  activePanel: "chat" | "plugins";
  onNewChat: () => void;
  onSelect: (id: string) => void;
  onOpenPlugins: () => void;
}) {
  return (
    <Sider
      className="sidebar"
      width={260}
      breakpoint="lg"
      collapsedWidth={72}
      collapsible
      trigger={null}
      defaultCollapsed={false}
    >
      <div className="logo-row">
        <Image className="logo-mark" src="/logo.png" alt="SunPilot logo" preview={false} />
        <Text className="logo-text" strong>SunPilot</Text>
      </div>

      <Button
        type="primary"
        size="large"
        block
        icon={<PlusOutlined />}
        onClick={onNewChat}
      >
        新建对话
      </Button>

      <SidebarNav
        active={activePanel === "plugins"}
        onOpenPlugins={onOpenPlugins}
      />

      <RecentConversations
        conversations={conversations}
        activeConversationId={activeConversationId}
        active={activePanel === "chat"}
        onSelect={onSelect}
        conversationTitle={conversationTitle}
      />

      <UserFooter />
    </Sider>
  );
}
