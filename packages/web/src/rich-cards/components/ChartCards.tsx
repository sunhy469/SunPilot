import { Progress, Typography, Tooltip } from "antd";
import type {
  BarChartCardData,
  PieChartCardData,
  LineChartCardData,
  AreaChartCardData,
  StatGridCardData,
  KpiCardData,
  ScatterChartCardData,
  RadarChartCardData,
  HeatmapCardData,
} from "../types";
import type { RichTextValue } from "../types";
import { RichCardShell } from "./RichCardShell";

const { Text } = Typography;

const CHART_COLORS = [
  "#2563eb", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6",
  "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#6366f1",
];

// ── BarChartCard ─────────────────────────────────────────────────────

export function BarChartCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: BarChartCardData;
}) {
  const max = Math.max(...data.items.map((i) => i.value)) || 1;
  const horizontal = data.horizontal ?? false;

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className={`rich-bars ${horizontal ? "rich-bars--horizontal" : ""}`}>
        {data.items.map((item, idx) => (
          <div key={`${item.label}-${idx}`} className="rich-bars__row">
            <Text className="rich-bars__label">{item.label}</Text>
            <Progress
              percent={Math.min(100, (item.value / max) * 100)}
              strokeColor={item.color ?? CHART_COLORS[idx % CHART_COLORS.length]}
              size="small"
              showInfo={false}
              style={{ flex: 1, margin: "0 8px" }}
            />
            <Text strong>
              {item.value}
              {data.unit ?? ""}
            </Text>
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── PieChartCard ─────────────────────────────────────────────────────

export function PieChartCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: PieChartCardData;
}) {
  const total = data.items.reduce((sum, i) => sum + i.value, 0) || 1;
  const segments = data.items.reduce<Array<{ color: string; start: number; end: number }>>(
    (acc, item, idx) => {
      const previous = acc.at(-1);
      const start = previous ? previous.end : 0;
      const end = start + (item.value / total) * 100;
      acc.push({ color: item.color || CHART_COLORS[idx % CHART_COLORS.length]!, start, end });
      return acc;
    },
    [],
  );
  const gradient = segments.map((seg) => `${seg.color} ${seg.start}% ${seg.end}%`).join(", ");

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-chart">
        <div className="rich-chart__donut" style={{ background: `conic-gradient(${gradient})` }} />
        <div className="rich-chart__legend">
          {data.items.map((item, idx) => (
            <div key={`${item.label}-${idx}`} className="rich-chart__legend-item">
              <span style={{ background: item.color ?? CHART_COLORS[idx % CHART_COLORS.length] }} />
              <Text strong>{item.label}</Text>
              <Text type="secondary">
                {item.value} ({((item.value / total) * 100).toFixed(1)}%)
              </Text>
            </div>
          ))}
          {data.totalLabel && (
            <Text type="secondary" style={{ marginTop: 4 }}>
              {data.totalLabel}: {total}
            </Text>
          )}
        </div>
      </div>
    </RichCardShell>
  );
}

// ── LineChartCard ────────────────────────────────────────────────────

export function LineChartCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: LineChartCardData;
}) {
  const allValues = data.series.flatMap((s) => s.data);
  const maxVal = Math.max(...allValues) || 1;
  const minVal = Math.min(...allValues);
  const range = maxVal - minVal || 1;

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-line-chart">
        <svg viewBox="0 0 400 200" className="rich-line-chart__svg" preserveAspectRatio="none">
          {data.series.map((series, si) => {
            const points = series.data
              .map((v, i) => {
                const x = (i / Math.max(series.data.length - 1, 1)) * 380 + 10;
                const y = 190 - ((v - minVal) / range) * 170;
                return `${x},${y}`;
              })
              .join(" ");

            return (
              <polyline
                key={series.name}
                points={points}
                fill="none"
                stroke={series.color ?? CHART_COLORS[si % CHART_COLORS.length]}
                strokeWidth="2"
              />
            );
          })}
        </svg>
        <div className="rich-line-chart__x-axis">
          {data.xAxis.map((label, i) => (
            <Text key={i} type="secondary" className="rich-line-chart__tick">
              {label}
            </Text>
          ))}
        </div>
        <div className="rich-line-chart__legend">
          {data.series.map((s, i) => (
            <div key={s.name} className="rich-chart__legend-item">
              <span style={{ background: s.color ?? CHART_COLORS[i % CHART_COLORS.length] }} />
              <Text>{s.name}</Text>
            </div>
          ))}
        </div>
        {data.yAxis?.unit && (
          <Text type="secondary" className="rich-line-chart__y-label">
            {data.yAxis.label ?? data.yAxis.unit}
          </Text>
        )}
      </div>
    </RichCardShell>
  );
}

// ── AreaChartCard ────────────────────────────────────────────────────

export function AreaChartCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: AreaChartCardData;
}) {
  const allValues = data.series.flatMap((s) => s.data);
  const maxVal = Math.max(...allValues) || 1;
  const minVal = Math.min(...allValues);
  const range = maxVal - minVal || 1;

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-line-chart">
        <svg viewBox="0 0 400 200" className="rich-line-chart__svg" preserveAspectRatio="none">
          {data.series.map((series, si) => {
            const dataPoints = series.data.map((v, i) => {
              const x = (i / Math.max(series.data.length - 1, 1)) * 380 + 10;
              const y = 190 - ((v - minVal) / range) * 170;
              return { x, y };
            });

            const linePoints = dataPoints.map((p) => `${p.x},${p.y}`).join(" ");
            const areaPoints = [
              ...dataPoints.map((p) => `${p.x},${p.y}`),
              `${dataPoints[dataPoints.length - 1]!.x},190`,
              `${dataPoints[0]!.x},190`,
            ].join(" ");

            const color = series.color ?? CHART_COLORS[si % CHART_COLORS.length];
            return (
              <g key={series.name}>
                <polygon points={areaPoints} fill={color} opacity={0.15} />
                <polyline points={linePoints} fill="none" stroke={color} strokeWidth="2" />
              </g>
            );
          })}
        </svg>
        <div className="rich-line-chart__x-axis">
          {data.xAxis.map((label, i) => (
            <Text key={i} type="secondary" className="rich-line-chart__tick">
              {label}
            </Text>
          ))}
        </div>
        <div className="rich-line-chart__legend">
          {data.series.map((s, i) => (
            <div key={s.name} className="rich-chart__legend-item">
              <span style={{ background: s.color ?? CHART_COLORS[i % CHART_COLORS.length] }} />
              <Text>{s.name}</Text>
            </div>
          ))}
        </div>
      </div>
    </RichCardShell>
  );
}

// ── StatGridCard ─────────────────────────────────────────────────────

export function StatGridCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: StatGridCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-metrics">
        {data.metrics.map((metric, idx) => (
          <div key={`${metric.label}-${idx}`} className={`rich-metric is-${metric.tone ?? "blue"}`}>
            <Text>{metric.label}</Text>
            <Text strong>{metric.value}</Text>
            {metric.change && <Text type="secondary">{metric.change}</Text>}
            {metric.description && (
              <Text type="secondary" style={{ fontSize: 12 }}>{metric.description}</Text>
            )}
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── KpiCard ──────────────────────────────────────────────────────────

export function KpiCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: KpiCardData;
}) {
  const trendIcon =
    data.trend === "up" ? "↑" : data.trend === "down" ? "↓" : "→";
  const trendColor =
    data.trend === "up"
      ? "#10b981"
      : data.trend === "down"
        ? "#ef4444"
        : "#94a3b8";

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-kpi">
        <Text type="secondary">{data.label}</Text>
        <div className="rich-kpi__value">
          <Text strong style={{ fontSize: 28 }}>{data.value}</Text>
          {data.trend && (
            <Text style={{ color: trendColor, fontSize: 16, marginLeft: 8 }}>
              {trendIcon} {data.change}
            </Text>
          )}
        </div>
        {data.source && (
          <Text type="secondary" style={{ fontSize: 12 }}>来源: {data.source}</Text>
        )}
      </div>
    </RichCardShell>
  );
}

// ── ScatterChartCard ─────────────────────────────────────────────────

export function ScatterChartCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: ScatterChartCardData;
}) {
  const allX = data.points.map((p) => p.x);
  const allY = data.points.map((p) => p.y);
  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const minY = Math.min(...allY);
  const maxY = Math.max(...allY);
  const rangeX = maxX - minX || 1;
  const rangeY = maxY - minY || 1;

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-line-chart">
        <svg viewBox="0 0 400 200" className="rich-line-chart__svg" preserveAspectRatio="none">
          {data.points.map((point, i) => {
            const cx = ((point.x - minX) / rangeX) * 380 + 10;
            const cy = 190 - ((point.y - minY) / rangeY) * 170;
            const r = point.size ? Math.max(3, Math.min(12, point.size)) : 5;
            return (
              <Tooltip key={i} title={point.label ?? `${point.x}, ${point.y}`}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill={point.color ?? CHART_COLORS[i % CHART_COLORS.length]}
                  opacity={0.75}
                />
              </Tooltip>
            );
          })}
        </svg>
        <div className="rich-line-chart__legend">
          <Text type="secondary">{data.xKey ?? "X"} vs {data.yKey ?? "Y"}</Text>
        </div>
      </div>
    </RichCardShell>
  );
}

// ── RadarChartCard ───────────────────────────────────────────────────

export function RadarChartCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: RadarChartCardData;
}) {
  const axisCount = data.axes.length;
  const center = 100;
  const maxRadius = 80;
  const angleStep = (2 * Math.PI) / axisCount;

  // Axis endpoints
  const axisEndpoints = data.axes.map((axis, i) => {
    const angle = -Math.PI / 2 + i * angleStep;
    return {
      x: center + maxRadius * Math.cos(angle),
      y: center + maxRadius * Math.sin(angle),
      label: axis.label,
      max: axis.max,
    };
  });

  // Grid rings (25%, 50%, 75%, 100%)
  const gridRings = [0.25, 0.5, 0.75, 1].map((ratio) =>
    axisEndpoints.map((_, i) => {
      const angle = -Math.PI / 2 + i * angleStep;
      return `${center + maxRadius * ratio * Math.cos(angle)},${center + maxRadius * ratio * Math.sin(angle)}`;
    }).join(" "),
  );

  // Series polygons
  const seriesPolygons = data.series.map((series, si) => {
    const points = data.axes.map((axis, i) => {
      const angle = -Math.PI / 2 + i * angleStep;
      const ratio = (series.values[i] ?? 0) / axis.max;
      return `${center + maxRadius * ratio * Math.cos(angle)},${center + maxRadius * ratio * Math.sin(angle)}`;
    }).join(" ");

    return { name: series.name, points, color: series.color ?? CHART_COLORS[si % CHART_COLORS.length] };
  });

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-line-chart">
        <svg viewBox="0 0 200 200" className="rich-line-chart__svg" style={{ maxHeight: 220 }}>
          {/* Grid rings */}
          {gridRings.map((ring, i) => (
            <polygon key={`ring-${i}`} points={ring} fill="none" stroke="#e5e7eb" strokeWidth="0.5" />
          ))}
          {/* Axis lines */}
          {axisEndpoints.map((ep, i) => (
            <line key={`axis-${i}`} x1={center} y1={center} x2={ep.x} y2={ep.y} stroke="#d1d5db" strokeWidth="0.5" />
          ))}
          {/* Axis labels */}
          {axisEndpoints.map((ep, i) => (
            <text
              key={`label-${i}`}
              x={ep.x}
              y={ep.y - 6}
              textAnchor="middle"
              fontSize="8"
              fill="#6b7280"
            >
              {ep.label}
            </text>
          ))}
          {/* Series polygons */}
          {seriesPolygons.map((sp) => (
            <g key={sp.name}>
              <polygon points={sp.points} fill={sp.color} opacity={0.15} stroke={sp.color} strokeWidth="1.5" />
            </g>
          ))}
        </svg>
        <div className="rich-line-chart__legend">
          {data.series.map((s, i) => (
            <div key={s.name} className="rich-chart__legend-item">
              <span style={{ background: s.color ?? CHART_COLORS[i % CHART_COLORS.length] }} />
              <Text>{s.name}</Text>
            </div>
          ))}
        </div>
      </div>
    </RichCardShell>
  );
}

// ── HeatmapCard ──────────────────────────────────────────────────────

export function HeatmapCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: HeatmapCardData;
}) {
  const values = data.cells.map((c) => c.value);
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal || 1;

  const cellWidth = Math.max(32, Math.min(60, 400 / data.columns.length));
  const cellHeight = 28;

  // Build a lookup for quick cell access
  const cellMap = new Map<string, { value: number; label?: string }>();
  for (const cell of data.cells) {
    cellMap.set(`${cell.row}-${cell.col}`, { value: cell.value, label: cell.label });
  }

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-heatmap">
        <div className="rich-heatmap__grid" style={{ display: "grid", gridTemplateColumns: `auto repeat(${data.columns.length}, ${cellWidth}px)`, gap: 2 }}>
          {/* Header row */}
          <div />
          {data.columns.map((col, i) => (
            <Text key={i} type="secondary" style={{ fontSize: 11, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {col}
            </Text>
          ))}
          {/* Data rows */}
          {data.rows.map((rowLabel, ri) => (
            <>
              <Text key={`row-${ri}`} type="secondary" style={{ fontSize: 11, paddingRight: 6, whiteSpace: "nowrap" }}>{rowLabel}</Text>
              {data.columns.map((_, ci) => {
                const cell = cellMap.get(`${ri}-${ci}`);
                const ratio = cell ? (cell.value - minVal) / range : 0;
                const opacity = cell ? 0.15 + ratio * 0.7 : 0.05;
                return (
                  <Tooltip key={`${ri}-${ci}`} title={cell ? (cell.label ?? `${rowLabel}: ${cell.value}`) : "-"}>
                    <div
                      style={{
                        height: cellHeight,
                        borderRadius: 4,
                        background: cell ? `rgba(37, 99, 235, ${opacity})` : "#f3f4f6",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        color: ratio > 0.5 ? "#fff" : "#374151",
                      }}
                    >
                      {cell?.label ?? (cell ? cell.value : "")}
                    </div>
                  </Tooltip>
                );
              })}
            </>
          ))}
        </div>
      </div>
    </RichCardShell>
  );
}
