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
  | "gallery"
  | "tool_result"
  | "skill_result"
  | "diagnostic"
  | "status"
  | "link_preview"
;

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

// ── New card types ────────────────────────────────────────────────────

export type ToolStatus = "running" | "completed" | "failed" | "pending";
export type SkillStatus = "running" | "completed" | "failed" | "pending";
export type StatusTone = "success" | "warning" | "error" | "info" | "neutral";

export interface ToolResultCardData {
  toolName: string;
  status: ToolStatus;
  toolCallId?: string;
  summary?: string;
  detail?: string;
  artifacts?: string[];
  error?: string;
  durationMs?: number;
  timestamp?: string;
}

export interface SkillResultCardData {
  skillName: string;
  status: SkillStatus;
  skillId?: string;
  steps?: Array<{
    title: string;
    description?: string;
    status: "done" | "active" | "pending" | "error";
  }>;
  summary?: string;
  detail?: string;
  error?: string;
  durationMs?: number;
  timestamp?: string;
}

export interface DiagnosticCardData {
  level: "info" | "warning" | "error" | "debug";
  message: string;
  source?: string;
  code?: string;
  stack?: string;
  timestamp?: string;
}

export interface StatusCardData {
  tone: StatusTone;
  label: string;
  message?: string;
  icon?: boolean;
}

export interface LinkPreviewCardData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  domain?: string;
  favicon?: string;
}

