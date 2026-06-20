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
  RichCardInteraction,
  RichCardView,
} from "@sunpilot/protocol";

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
  columns: Array<{
    key: string;
    label: RichTextValue;
    type?: "text" | "number" | "link" | "markdown" | "badge" | "image" | "actions";
    width?: number;
    sortable?: boolean;
  }>;
  rows: Array<Record<string, RichTextValue | number | boolean | null>>;
  pagination?: false | { pageSize?: number };
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
    description?: RichTextValue;
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

export interface LinkPreviewCardData {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  domain?: string;
  favicon?: string;
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

// ── Text & knowledge cards ────────────────────────────────────────────

export interface RichTextCardData {
  content: string;
  format?: "plain" | "markdown" | "auto";
}

export interface DefinitionListCardData {
  items: Array<{
    term: string;
    description: string;
  }>;
}

export interface QuoteCardData {
  quote: string;
  source?: string;
  url?: string;
}

export interface CitationListCardData {
  items: Array<{
    title: string;
    url?: string;
    snippet?: string;
  }>;
}

export interface CodeDiffCardData {
  language?: string;
  diff: string;
  fileName?: string;
}

export interface JsonViewerCardData {
  value: unknown;
  collapsedDepth?: number;
  rootName?: string;
}

// ── List & task cards ─────────────────────────────────────────────────

export interface ChecklistCardData {
  items: Array<{
    id: string;
    label: RichTextValue;
    description?: RichTextValue;
    checked?: boolean;
    required?: boolean;
    disabled?: boolean;
    evidence?: RichTextValue;
  }>;
  mode?: "local" | "submit";
  submitLabel?: string;
  requireAll?: boolean;
  confirmationText?: RichTextValue;
}

export interface ActionListCardData {
  items: Array<{
    id: string;
    title: string;
    description?: string;
    action?: { label: string; type: string; payload?: Record<string, unknown> };
    completed?: boolean;
  }>;
}

export interface RankedListCardData {
  items: Array<{
    title: string;
    score?: number | string;
    description?: string;
    badge?: string;
  }>;
}

export interface StepsCardData {
  steps: Array<{
    title: string;
    description?: string;
    status: "done" | "active" | "pending" | "error";
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

export interface ComparisonTableCardData {
  subjects: Array<{ name: string; description?: string }>;
  criteria: Array<{ key: string; label: string }>;
  values: Array<Array<string | number | boolean | null>>;
  highlight?: "differences" | "best";
}

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
