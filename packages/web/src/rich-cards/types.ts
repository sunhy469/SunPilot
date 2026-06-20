export type { RichTextValue } from "@sunpilot/protocol";
import type { RichTextValue } from "@sunpilot/protocol";
export type {
  RichCardType,
  RichCardAction,
  RichCardInteraction,
  RichCardView,
} from "@sunpilot/protocol";
import type {
  RichCardType,
  RichCardAction,
  RichCardInteraction,
  RichCardView,
} from "@sunpilot/protocol";
export type { ToolStatus, SkillStatus, StatusTone } from "./components/IconStatusWidget";
import type { ToolStatus, SkillStatus, StatusTone } from "./components/IconStatusWidget";

export interface ChartCardItem {
  label: string;
  value: number;
  color?: string;
}

export interface ChartCardData {
  chartType: "donut" | "bar";
  items: ChartCardItem[];
}

export interface VideoCardData {
  src: string;
  poster?: string;
  caption?: string;
}

export interface GalleryCardData {
  images: Array<{
    src: string;
    alt?: string;
    caption?: string;
  }>;
}

// ── New card types ────────────────────────────────────────────────────

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
  stepCount?: number;
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

export interface ImageCardData {
  src: string;
  alt?: string;
  caption?: string;
}

// ── Chart cards ──────────────────────────────────────────────────────

export interface BarChartCardData {
  items: Array<{ label: string; value: number; color?: string; group?: string }>;
  axis?: { x?: string; y?: string };
  unit?: string;
  stacked?: boolean;
  horizontal?: boolean;
}

export interface PieChartCardData {
  items: Array<{ label: string; value: number; color?: string }>;
  totalLabel?: string;
}

export interface LineChartCardData {
  series: Array<{ name: string; data: number[]; color?: string }>;
  xAxis: string[];
  yAxis?: { label?: string; unit?: string };
}

export interface AreaChartCardData {
  series: Array<{ name: string; data: number[]; color?: string }>;
  xAxis: string[];
  yAxis?: { label?: string; unit?: string };
}

export interface ScatterChartCardData {
  points: Array<{ x: number; y: number; label?: string; size?: number; color?: string }>;
  xKey?: string;
  yKey?: string;
}

export interface RadarChartCardData {
  axes: Array<{ label: string; max: number }>;
  series: Array<{ name: string; values: number[]; color?: string }>;
}

export interface HeatmapCardData {
  rows: string[];
  columns: string[];
  cells: Array<{ row: number; col: number; value: number; label?: string }>;
}

export interface StatGridCardData {
  metrics: Array<{
    label: string;
    value: string | number;
    change?: string;
    tone?: "blue" | "green" | "yellow" | "pink";
    description?: string;
  }>;
}

export interface KpiCardData {
  label: string;
  value: string | number;
  trend?: "up" | "down" | "flat";
  change?: string;
  source?: string;
}

// ── Media & file cards ────────────────────────────────────────────────

export interface AudioCardData {
  src: string;
  duration?: number;
  transcript?: string;
  title?: RichTextValue;
}

export interface FileBundleCardData {
  files: Array<{
    name: string;
    size?: string;
    href?: string;
    type?: string;
  }>;
}

export interface PdfPreviewCardData {
  src: string;
  pages?: number;
  title?: RichTextValue;
}

// ── Interaction cards ─────────────────────────────────────────────────

export interface ActionListCardData {
  items: Array<{
    id: string;
    title: string;
    description?: string;
    action?: { label: string; type: string; payload?: Record<string, unknown> };
    completed?: boolean;
  }>;
}

export interface ApprovalSummaryCardData {
  items: Array<{
    id: string;
    title: string;
    description?: string;
    riskLevel?: "low" | "medium" | "high";
    status?: "pending" | "approved" | "rejected";
  }>;
  riskLevel?: "low" | "medium" | "high";
}

// ── Table & data collection cards ─────────────────────────────────────

export interface ProductGridCardData {
  items: Array<{
    title: string;
    image?: string;
    price?: string;
    url?: string;
    description?: string;
    badge?: string;
  }>;
}

export interface RecordCardData {
  fields: Array<{
    key: string;
    label: string;
    value: string;
    type?: "text" | "link" | "code" | "badge";
  }>;
  title?: RichTextValue;
}

export interface KanbanCardData {
  columns: Array<{ id: string; label: string }>;
  cards: Array<{
    id: string;
    title: string;
    columnId: string;
    description?: string;
    badge?: string;
  }>;
}

// ── Form & selection cards ────────────────────────────────────────────

export interface ChoiceGroupCardData {
  options: Array<{
    id: string;
    label: string;
    description?: string;
  }>;
  mode: "single" | "multiple";
  selectedIds?: string[];
}

export interface FormCardData {
  fields: Array<{
    id: string;
    label: string;
    type: "text" | "textarea" | "number" | "select" | "email";
    placeholder?: string;
    required?: boolean;
    options?: Array<{ label: string; value: string }>;
  }>;
  submitLabel?: string;
}

export interface RatingCardData {
  scale: number;
  labels?: Array<string>;
  value?: number;
}

export interface DatePickerCardData {
  mode: "date" | "time" | "datetime";
  min?: string;
  max?: string;
  value?: string;
}

// ── Interaction protocol (RichCardAction imported from @sunpilot/protocol) ──

export interface RichCardRendererProps {
  cards?: RichCardView[];
  stateByCardId?: Record<string, unknown>;
  onAction?: (action: RichCardAction) => void;
}
