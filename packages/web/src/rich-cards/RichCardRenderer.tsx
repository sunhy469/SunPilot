import { Component, memo, type ComponentType, type ReactNode } from "react";
import { Flex, Typography } from "antd";
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
  StatusTone,
} from "./types";
import { SummaryCard, InfoCard, ErrorCard, FileCard } from "./components/BasicCards";
import { ChartCard } from "./components/ChartCard";
import {
  CodeCard,
  GalleryCard,
  MetricCard,
  TimelineCard,
  VideoCard,
} from "./components/MediaCards";
import { ProgressCard } from "./components/ProgressCard";
import { TableCard } from "./components/TableCard";
import { ToolResultWidget } from "./components/ToolResultWidget";
import { SkillResultWidget } from "./components/SkillResultWidget";
import { FileLinkWidget } from "./components/FileLinkWidget";
import { StatusBadge, InfoTip } from "./components/IconStatusWidget";
import "./rich-cards.css";

const { Text } = Typography;

// ── Per-card Error Boundary ───────────────────────────────────────────
// Prevents a single malformed card from crashing the entire card stack.

interface ErrorBoundaryState {
  hasError: boolean;
}

class CardErrorBoundary extends Component<
  { cardId: string; children: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { cardId: string; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(
      `[RichCard] "${this.props.cardId}" render failed:`,
      error,
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rich-card rich-card--error-fallback">
          <Text type="danger">卡片渲染失败</Text>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Type-safe helper for "simple" cards ───────────────────────────────
// 12 of 17 card types follow the same shape: { title?, subtitle?, data: T }.
// This helper eliminates the need for `as any` by threading the data type `T`.

function renderSimple<T>(
  Component: ComponentType<{
    title?: string;
    subtitle?: string;
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
// Each entry owns its type assertion — no `as any` at the dispatch level.

type CardRendererFn = (card: RichCardView) => ReactNode;

const CARD_REGISTRY: Record<RichCardType, CardRendererFn> = {
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

// ── RichCard (memoized, error-bounded, data-attributed) ─────────────

const RichCard = memo(function RichCard({ card }: { card: RichCardView }) {
  const render = CARD_REGISTRY[card.type];

  return (
    <CardErrorBoundary cardId={card.id}>
      <div
        className="rich-card-wrapper"
        data-card-type={card.type}
        data-card-id={card.id}
      >
        {render
          ? render(card)
          : <InfoCard title={card.title} data={{ text: `未知卡片类型: ${card.type}` }} />}
      </div>
    </CardErrorBoundary>
  );
});

// ── RichCardRenderer (public) ───────────────────────────────────────

export const RichCardRenderer = memo(function RichCardRenderer({
  cards,
}: {
  cards?: RichCardView[];
}) {
  if (!cards || cards.length === 0) return null;

  return (
    <Flex vertical gap={12} className="rich-cards-stack">
      {cards.map((card, index) => {
        // Fallback key for cards missing id (backward compat with old backend data)
        const cardKey = card.id || `${card.type}_${index}`;
        const normalizedCard: RichCardView = card.id
          ? card
          : { ...card, id: cardKey };
        return <RichCard key={cardKey} card={normalizedCard} />;
      })}
    </Flex>
  );
});
