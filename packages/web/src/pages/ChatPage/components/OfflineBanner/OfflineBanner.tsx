import { Alert } from "antd";

export function OfflineBanner() {
  return (
    <Alert
      type="warning"
      showIcon
      message="SunPilot daemon 暂时不可用"
      description="请确认本地 daemon 已启动，或检查反向代理 WebSocket 配置。"
    />
  );
}
