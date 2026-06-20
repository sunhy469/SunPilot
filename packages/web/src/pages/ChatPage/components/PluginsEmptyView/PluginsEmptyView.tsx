import { Empty, Typography } from "antd";
import "./PluginsEmptyView.scss";

const { Title, Paragraph, Text } = Typography;

export function PluginsEmptyView() {
  return (
    <div className="plugins-empty-view">
      <Empty
        image={<img src="/logo.png" alt="SunPilot logo" className="plugins-empty-view__logo" />}
        description={null}
      >
        <div className="plugins-empty-view__inner">
          <Text type="secondary" className="plugins-empty-view__kicker">插件</Text>
          <Title level={4}>插件空间暂时为空</Title>
          <Paragraph type="secondary">
            这里会承载可用插件、技能入口和工具能力。当前先保留清爽空状态，让对话区和插件区在同一个工作台内切换。
          </Paragraph>
        </div>
      </Empty>
    </div>
  );
}
