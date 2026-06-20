export { RichCardRenderer } from "./RichCardRenderer";
export { MarkdownRenderer } from "./MarkdownRenderer";
export type { MarkdownRendererProps } from "./MarkdownRenderer";

// ── Card Registry ──────────────────────────────────────────────────────
export { CARD_REGISTRY } from "./registry";
export type { CardRendererFn } from "./registry";

// ── Widget Components ─────────────────────────────────────────────────
export {
  StatusBadge,
  ToolStatusBadge,
  SkillStatusBadge,
  InfoTip,
  IconStatusWidget,
} from "./components/IconStatusWidget";
export type {
  StatusTone,
  ToolStatus,
  SkillStatus,
  StatusBadgeProps,
  ToolStatusBadgeProps,
  SkillStatusBadgeProps,
  InfoTipProps,
} from "./components/IconStatusWidget";

export { CodeBlockWidget } from "./components/CodeBlockWidget";
export type { CodeBlockWidgetProps } from "./components/CodeBlockWidget";

export { FileLinkWidget } from "./components/FileLinkWidget";
export type { FileLinkWidgetProps, FileTypeHint } from "./components/FileLinkWidget";

export { ToolResultWidget } from "./components/ToolResultWidget";
export type { ToolResultWidgetProps } from "./components/ToolResultWidget";

export { SkillResultWidget } from "./components/SkillResultWidget";
export type { SkillResultWidgetProps, SkillStep } from "./components/SkillResultWidget";

// ── Types ─────────────────────────────────────────────────────────────
export { RichTextRenderer } from "./richText";
export type { RichTextValue, RichTextObject, LinkifySegment } from "./richText";
export { normalizeRichText } from "./richText";

export type {
  RichCardType,
  RichCardView,
  RichCardAction,
  RichCardInteraction,
  ProgressStep,
  ProgressCardData,
  ChartCardItem,
  ChartCardData,
  TableCardData,
  VideoCardData,
  MetricCardData,
  TimelineCardData,
  CodeCardData,
  GalleryCardData,
  ToolResultCardData,
  SkillResultCardData,
  DiagnosticCardData,
  StatusCardData,
  LinkPreviewCardData,
  ImageCardData,
  BarChartCardData,
  PieChartCardData,
  LineChartCardData,
  AreaChartCardData,
  ScatterChartCardData,
  RadarChartCardData,
  HeatmapCardData,
  StatGridCardData,
  KpiCardData,
  AudioCardData,
  FileBundleCardData,
  PdfPreviewCardData,
  RecordCardData,
  ProductGridCardData,
  RichTextCardData,
  DefinitionListCardData,
  QuoteCardData,
  CitationListCardData,
  CodeDiffCardData,
  JsonViewerCardData,
  ComparisonTableCardData,
  RankedListCardData,
  ChecklistCardData,
  ChoiceGroupCardData,
  ApprovalSummaryCardData,
  ActionListCardData,
  RatingCardData,
  StepsCardData,
  KanbanCardData,
  FormCardData,
  DatePickerCardData,
  RichCardRendererProps,
} from "./types";
