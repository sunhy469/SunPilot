import { Image, Typography, Empty } from "antd";
import { FileOutlined, VideoCameraOutlined, SoundOutlined, FilePdfOutlined } from "@ant-design/icons";
import type { AiOutputItem } from "../../utils/collectAiOutputs";
import "./OutputsPopover.scss";

const { Text } = Typography;

function formatTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays < 7) return `${diffDays} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function OutputIcon({ type }: { type: AiOutputItem["type"] }) {
  const iconStyle = { fontSize: 20, color: "var(--sp-blue)" };
  switch (type) {
    case "video":
      return <VideoCameraOutlined style={iconStyle} />;
    case "audio":
      return <SoundOutlined style={iconStyle} />;
    case "pdf":
      return <FilePdfOutlined style={iconStyle} />;
    case "file":
      return <FileOutlined style={iconStyle} />;
    default:
      return null;
  }
}

export function OutputsPopover({ outputs }: { outputs: AiOutputItem[] }) {
  if (outputs.length === 0) {
    return (
      <div className="outputs-popover">
        <div className="outputs-popover__header">
          <Text strong>产物</Text>
        </div>
        <div className="outputs-popover__empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无产物" />
        </div>
      </div>
    );
  }

  return (
    <div className="outputs-popover">
      <div className="outputs-popover__header">
        <Text strong>产物</Text>
        <Text type="secondary" className="outputs-popover__count">
          {outputs.length} 个
        </Text>
      </div>
      <div className="outputs-popover__list">
        {outputs.map((output) => (
          <div key={output.id} className="outputs-popover__item">
            {output.type === "image" && output.url ? (
              <div className="outputs-popover__image">
                <Image
                  src={output.url}
                  alt={output.title}
                  width={80}
                  height={80}
                  style={{ objectFit: "cover", borderRadius: 6 }}
                  preview={{ mask: "预览" }}
                />
              </div>
            ) : output.type === "video" && output.url ? (
              <div className="outputs-popover__video">
                <video
                  src={output.url}
                  controls
                  width={200}
                  height={120}
                  style={{ borderRadius: 6 }}
                />
              </div>
            ) : (
              <div className="outputs-popover__file">
                <OutputIcon type={output.type} />
                <div className="outputs-popover__file-info">
                  <Text className="outputs-popover__file-name" ellipsis={{ tooltip: output.title }}>
                    {output.title}
                  </Text>
                  <Text type="secondary" className="outputs-popover__file-time">
                    {formatTime(output.createdAt)}
                  </Text>
                </div>
                {output.url && (
                  <a
                    href={output.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="outputs-popover__file-link"
                  >
                    打开
                  </a>
                )}
              </div>
            )}
            {(output.type === "image" || output.type === "video") && (
              <div className="outputs-popover__item-meta">
                <Text type="secondary" className="outputs-popover__item-time">
                  {formatTime(output.createdAt)}
                </Text>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
