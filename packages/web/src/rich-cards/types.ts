export type RichCardType =
  | "progress"
  | "chart"
  | "summary"
  | "file"
  | "info"
  | "error"
  | "table"
  | "video"
  | "metric"
  | "timeline"
  | "code"
  | "gallery";

export interface RichCardView<TData = unknown> {
  id: string;
  type: RichCardType;
  title?: string;
  subtitle?: string;
  data: TData;
}

export interface ProgressStep {
  title: string;
  description?: string;
  status: "done" | "active" | "pending" | "error";
}

export interface ProgressCardData {
  steps: ProgressStep[];
}

export interface ChartCardItem {
  label: string;
  value: number;
  color?: string;
}

export interface ChartCardData {
  chartType: "donut" | "bar";
  items: ChartCardItem[];
}

export interface TableCardData {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number>>;
}

export interface VideoCardData {
  src: string;
  poster?: string;
  caption?: string;
}

export interface MetricCardData {
  metrics: Array<{
    label: string;
    value: string | number;
    change?: string;
    tone?: "blue" | "green" | "yellow" | "pink";
  }>;
}

export interface TimelineCardData {
  items: Array<{
    title: string;
    time?: string;
    description?: string;
    status?: "done" | "active" | "pending" | "error";
  }>;
}

export interface CodeCardData {
  language?: string;
  fileName?: string;
  code: string;
}

export interface GalleryCardData {
  images: Array<{
    src: string;
    alt?: string;
    caption?: string;
  }>;
}
