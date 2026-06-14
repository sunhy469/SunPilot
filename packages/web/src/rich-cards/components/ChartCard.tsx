import { Progress, Typography } from "antd";
import type { ChartCardData } from "../types";
import { RichCardShell } from "./RichCardShell";

const { Text } = Typography;

export function ChartCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: ChartCardData;
}) {
  const total = data.items.reduce((sum, item) => sum + item.value, 0) || 1;
  const segments = data.items.reduce<Array<{ color: string; start: number; end: number }>>(
    (acc, item) => {
      const previous = acc.at(-1);
      const start = previous ? previous.end : 0;
      const end = start + (item.value / total) * 100;
      acc.push({ color: item.color ?? "#1f7aff", start, end });
      return acc;
    },
    [],
  );
  const gradient = segments.map((seg) => `${seg.color} ${seg.start}% ${seg.end}%`).join(", ");

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      {data.chartType === "bar" ? (
        <div className="rich-bars">
          {data.items.map((item) => (
            <div key={item.label} className="rich-bars__row">
              <Text className="rich-bars__label">{item.label}</Text>
              <Progress
                percent={Math.min(100, (item.value / total) * 100)}
                strokeColor={item.color ?? "#1f7aff"}
                size="small"
                showInfo={false}
                style={{ flex: 1, margin: "0 8px" }}
              />
              <Text strong>{item.value}%</Text>
            </div>
          ))}
        </div>
      ) : (
        <div className="rich-chart">
          <div className="rich-chart__donut" style={{ background: `conic-gradient(${gradient})` }} />
          <div className="rich-chart__legend">
            {data.items.map((item) => (
              <div key={item.label} className="rich-chart__legend-item">
                <span style={{ background: item.color ?? "#1f7aff" }} />
                <Text strong>{item.label}</Text>
                <Text type="secondary">{item.value}%</Text>
              </div>
            ))}
          </div>
        </div>
      )}
    </RichCardShell>
  );
}
