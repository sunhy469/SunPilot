import type { ChartCardData } from "../types";
import { RichCardShell } from "./RichCardShell";

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
              <span className="rich-bars__label">{item.label}</span>
              <span className="rich-bars__track">
                <span
                  className="rich-bars__fill"
                  style={{
                    width: `${Math.min(100, (item.value / total) * 100)}%`,
                    background: item.color ?? "#1f7aff",
                  }}
                />
              </span>
              <strong>{item.value}%</strong>
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
                <b>{item.label}</b>
                <em>{item.value}%</em>
              </div>
            ))}
          </div>
        </div>
      )}
    </RichCardShell>
  );
}
