import { Timeline, Typography } from "antd";
import type { AgentTimelineItem } from "../hooks/useChat";
import "./AgentTimeline.css";

const { Text } = Typography;

const toneColor: Record<string, string> = {
  info: "blue",
  success: "green",
  warning: "orange",
  error: "red",
};

export function AgentTimeline({ items }: { items: AgentTimelineItem[] }) {
  if (items.length === 0) return null;

  return (
    <div className="agent-timeline">
      <Timeline
        items={items.map((item) => ({
          color: toneColor[item.tone] ?? "blue",
          children: (
            <div className="agent-timeline__body">
              <Text strong>{item.title}</Text>
              {item.detail && (
                <div className="agent-timeline__detail">
                  <Text type="secondary">{item.detail}</Text>
                </div>
              )}
            </div>
          ),
        }))}
      />
    </div>
  );
}
