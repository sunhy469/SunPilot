import { Button, Space } from "antd";

interface MovementTestBarProps {
  onMoveTo: (targetNodeId: string) => void;
}

const testTargets = [
  { nodeId: "video_workstation", label: "去视频工作台" },
  { nodeId: "artifact_box", label: "去产物箱" },
  { nodeId: "tiktok_station", label: "去 TikTok" },
  { nodeId: "home", label: "回家" },
];

export function MovementTestBar({ onMoveTo }: MovementTestBarProps) {
  return (
    <div className="movement-test-bar">
      <Space size="small">
        {testTargets.map((t) => (
          <Button
            key={t.nodeId}
            size="small"
            onClick={() => onMoveTo(t.nodeId)}
          >
            {t.label}
          </Button>
        ))}
      </Space>
    </div>
  );
}
