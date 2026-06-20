import type { ComponentType, ReactNode } from "react";
import type {
  RichCardType,
  RichCardView,
  ProgressCardData,
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
  StatusTone,
  BarChartCardData,
  PieChartCardData,
  LineChartCardData,
  AreaChartCardData,
  StatGridCardData,
  KpiCardData,
  ScatterChartCardData,
  RadarChartCardData,
  HeatmapCardData,
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
  RichCardAction,
} from "./types";
import type { RichTextValue } from "./types";
import { SummaryCard, InfoCard, ErrorCard, FileCard } from "./components/BasicCards";
import { ChartCard } from "./components/ChartCard";
import {
  BarChartCard,
  PieChartCard,
  LineChartCard,
  AreaChartCard,
  StatGridCard,
  KpiCard,
  ScatterChartCard,
  RadarChartCard,
  HeatmapCard,
} from "./components/ChartCards";
import {
  CodeCard,
  GalleryCard,
  MetricCard,
  TimelineCard,
  VideoCard,
  ImageCard,
} from "./components/MediaCards";
import {
  AudioCard,
  FileBundleCard,
  PdfPreviewCard,
  RecordCard,
  ProductGridCard,
} from "./components/MediaExtCards";
import {
  RichTextCard,
  DefinitionListCard,
  QuoteCard,
  CitationListCard,
  CodeDiffCard,
  JsonViewerCard,
  ComparisonTableCard,
  RankedListCard,
} from "./components/TextCards";
import {
  ChecklistCard,
  ChoiceGroupCard,
  ApprovalSummaryCard,
  ActionListCard,
  RatingCard,
  StepsCard,
  KanbanCard,
  FormCard,
  DatePickerCard,
} from "./components/InteractiveCards";
import { ProgressCard } from "./components/ProgressCard";
import { TableCard } from "./components/TableCard";
import { ToolResultWidget } from "./components/ToolResultWidget";
import { SkillResultWidget } from "./components/SkillResultWidget";
import { FileLinkWidget } from "./components/FileLinkWidget";
import { StatusBadge, InfoTip } from "./components/IconStatusWidget";

// ── Type-safe helper for "simple" cards ───────────────────────────────

function renderSimple<T>(
  Component: ComponentType<{
    title?: RichTextValue;
    subtitle?: RichTextValue;
    data: T;
  }>,
  card: RichCardView<T>,
): ReactNode {
  return (
    <Component title={card.title} subtitle={card.subtitle} data={card.data} />
  );
}

// ── Card Registry ─────────────────────────────────────────────────────
// RichCardType → render function.  O(1) lookup replaces the switch block.

export type CardRendererFn = (
  card: RichCardView,
  cardState?: unknown,
  onAction?: (action: { type: string; cardId?: string; itemId?: string; checked?: boolean; payload?: Record<string, unknown> }) => void,
) => ReactNode;

export const CARD_REGISTRY: Record<RichCardType, CardRendererFn> = {
  // ── Simple cards (title + subtitle + typed data) ──────────────────
  progress: (c) => renderSimple(ProgressCard, c as RichCardView<ProgressCardData>),
  chart: (c) => renderSimple(ChartCard, c as RichCardView<ChartCardData>),
  summary: (c) => renderSimple(SummaryCard, c as RichCardView<{ text: string }>),
  file: (c) =>
    renderSimple(
      FileCard,
      c as RichCardView<{
        fileName?: string;
        fileSize?: string;
        href?: string;
      }>,
    ),
  info: (c) => renderSimple(InfoCard, c as RichCardView<{ text: string }>),
  error: (c) =>
    renderSimple(
      ErrorCard,
      c as RichCardView<{ text?: string; message?: string }>,
    ),
  table: (c) => renderSimple(TableCard, c as RichCardView<TableCardData>),
  video: (c) => renderSimple(VideoCard, c as RichCardView<VideoCardData>),
  metric: (c) => renderSimple(MetricCard, c as RichCardView<MetricCardData>),
  timeline: (c) =>
    renderSimple(TimelineCard, c as RichCardView<TimelineCardData>),
  code: (c) => renderSimple(CodeCard, c as RichCardView<CodeCardData>),
  gallery: (c) =>
    renderSimple(GalleryCard, c as RichCardView<GalleryCardData>),
  image: (c) => renderSimple(ImageCard, c as RichCardView<ImageCardData>),
  bar_chart: (c) => renderSimple(BarChartCard, c as RichCardView<BarChartCardData>),
  pie_chart: (c) => renderSimple(PieChartCard, c as RichCardView<PieChartCardData>),
  line_chart: (c) => renderSimple(LineChartCard, c as RichCardView<LineChartCardData>),
  area_chart: (c) => renderSimple(AreaChartCard, c as RichCardView<AreaChartCardData>),
  stat_grid: (c) => renderSimple(StatGridCard, c as RichCardView<StatGridCardData>),
  kpi_card: (c) => renderSimple(KpiCard, c as RichCardView<KpiCardData>),
  scatter_chart: (c) => renderSimple(ScatterChartCard, c as RichCardView<ScatterChartCardData>),
  radar_chart: (c) => renderSimple(RadarChartCard, c as RichCardView<RadarChartCardData>),
  heatmap: (c) => renderSimple(HeatmapCard, c as RichCardView<HeatmapCardData>),
  audio: (c) => renderSimple(AudioCard, c as RichCardView<AudioCardData>),
  file_bundle: (c) => renderSimple(FileBundleCard, c as RichCardView<FileBundleCardData>),
  pdf_preview: (c) => renderSimple(PdfPreviewCard, c as RichCardView<PdfPreviewCardData>),
  rich_text: (c) => renderSimple(RichTextCard, c as RichCardView<RichTextCardData>),
  definition_list: (c) => renderSimple(DefinitionListCard, c as RichCardView<DefinitionListCardData>),
  quote_card: (c) => renderSimple(QuoteCard, c as RichCardView<QuoteCardData>),
  citation_list: (c) => renderSimple(CitationListCard, c as RichCardView<CitationListCardData>),
  code_diff: (c) => renderSimple(CodeDiffCard, c as RichCardView<CodeDiffCardData>),
  json_viewer: (c) => renderSimple(JsonViewerCard, c as RichCardView<JsonViewerCardData>),
  checklist: (c, _state, onAction) => <ChecklistCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<ChecklistCardData>).data} cardState={_state as { checkedItemIds?: string[] }} onAction={onAction} />,
  action_list: (c, _state, onAction) => <ActionListCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<ActionListCardData>).data} onAction={onAction} />,
  ranked_list: (c) => renderSimple(RankedListCard, c as RichCardView<RankedListCardData>),
  steps: (c) => renderSimple(StepsCard, c as RichCardView<StepsCardData>),
  approval_summary: (c, _state, onAction) => <ApprovalSummaryCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<ApprovalSummaryCardData>).data} onAction={onAction} />,
  comparison_table: (c) => renderSimple(ComparisonTableCard, c as RichCardView<ComparisonTableCardData>),
  product_grid: (c) => renderSimple(ProductGridCard, c as RichCardView<ProductGridCardData>),
  record_card: (c) => renderSimple(RecordCard, c as RichCardView<RecordCardData>),
  kanban: (c) => renderSimple(KanbanCard, c as RichCardView<KanbanCardData>),
  choice_group: (c, _state, onAction) => <ChoiceGroupCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<ChoiceGroupCardData>).data} cardState={_state as { selectedIds?: string[] }} onAction={onAction} />,
  form_card: (c, _state, onAction) => <FormCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<FormCardData>).data} onAction={onAction} />,
  rating_card: (c, _state, onAction) => <RatingCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<RatingCardData>).data} onAction={onAction} />,
  date_picker_card: (c, _state, onAction) => <DatePickerCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<DatePickerCardData>).data} onAction={onAction} />,

  // ── Complex cards (flattened data → individual props) ─────────────
  tool_result: (c) => {
    const d = (c as RichCardView<ToolResultCardData>).data;
    return (
      <ToolResultWidget
        title={c.title}
        toolName={d.toolName}
        status={d.status}
        toolCallId={d.toolCallId}
        summary={d.summary}
        detail={d.detail}
        artifacts={d.artifacts}
        error={d.error}
        durationMs={d.durationMs}
        timestamp={d.timestamp}
      />
    );
  },

  skill_result: (c) => {
    const d = (c as RichCardView<SkillResultCardData>).data;
    return (
      <SkillResultWidget
        title={c.title}
        skillName={d.skillName}
        status={d.status}
        skillId={d.skillId}
        steps={d.steps}
        stepCount={d.stepCount}
        summary={d.summary}
        detail={d.detail}
        error={d.error}
        durationMs={d.durationMs}
        timestamp={d.timestamp}
      />
    );
  },

  diagnostic: (c) => {
    const d = (c as RichCardView<DiagnosticCardData>).data;
    const tone: StatusTone =
      d.level === "error"
        ? "error"
        : d.level === "warning"
          ? "warning"
          : d.level === "debug"
            ? "neutral"
            : "info";
    return <InfoTip message={d.message} tone={tone} />;
  },

  status: (c) => {
    const d = (c as RichCardView<StatusCardData>).data;
    return (
      <StatusBadge tone={d.tone} label={d.label} icon={d.icon !== false} />
    );
  },

  link_preview: (c) => {
    const d = (c as RichCardView<LinkPreviewCardData>).data;
    return (
      <FileLinkWidget
        title={c.title}
        fileName={d.title || d.url}
        url={d.url}
        fileType="unknown"
        description={d.description}
        subtitle={c.subtitle}
      />
    );
  },
};
