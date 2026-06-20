import type { ComponentType, ReactNode } from "react";
import type {
  RichCardType,
  RichCardView,
  ChartCardData,
  VideoCardData,
  GalleryCardData,
  ToolResultCardData,
  SkillResultCardData,
  DiagnosticCardData,
  StatusCardData,
  ImageCardData,
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
  ChoiceGroupCardData,
  ApprovalSummaryCardData,
  ActionListCardData,
  RatingCardData,
  KanbanCardData,
  FormCardData,
  DatePickerCardData,
} from "./types";
import type { RichTextValue } from "./types";
import { FileCard } from "./components/BasicCards";
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
  GalleryCard,
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
  ChoiceGroupCard,
  ApprovalSummaryCard,
  ActionListCard,
  RatingCard,
  KanbanCard,
  FormCard,
  DatePickerCard,
} from "./components/InteractiveCards";
import { ToolResultWidget } from "./components/ToolResultWidget";
import { SkillResultWidget } from "./components/SkillResultWidget";
import { StatusBadge, InfoTip } from "./components/IconStatusWidget";
import type { StatusTone } from "./components/IconStatusWidget";

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
  // ── Active card types ─────────────────────────────────────────────
  chart: (c) => renderSimple(ChartCard, c as RichCardView<ChartCardData>),
  file: (c) =>
    renderSimple(
      FileCard,
      c as RichCardView<{
        fileName?: string;
        fileSize?: string;
        href?: string;
      }>,
    ),
  video: (c) => renderSimple(VideoCard, c as RichCardView<VideoCardData>),
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
  action_list: (c, _state, onAction) => <ActionListCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<ActionListCardData>).data} onAction={onAction} />,
  approval_summary: (c, _state, onAction) => <ApprovalSummaryCard title={c.title} subtitle={c.subtitle} data={(c as RichCardView<ApprovalSummaryCardData>).data} onAction={onAction} />,
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
};
