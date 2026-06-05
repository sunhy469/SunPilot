import { memo } from "react";
import type { RichCardView } from "./types";
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
import "./rich-cards.css";

function RichCard({ card }: { card: RichCardView }) {
  const common = {
    title: card.title,
    subtitle: card.subtitle,
    data: card.data as any,
  };

  switch (card.type) {
    case "progress":
      return <ProgressCard {...common} />;
    case "chart":
      return <ChartCard {...common} />;
    case "summary":
      return <SummaryCard {...common} />;
    case "file":
      return <FileCard {...common} />;
    case "info":
      return <InfoCard {...common} />;
    case "error":
      return <ErrorCard {...common} />;
    case "table":
      return <TableCard {...common} />;
    case "video":
      return <VideoCard {...common} />;
    case "metric":
      return <MetricCard {...common} />;
    case "timeline":
      return <TimelineCard {...common} />;
    case "code":
      return <CodeCard {...common} />;
    case "gallery":
      return <GalleryCard {...common} />;
    default:
      return null;
  }
}

export const RichCardRenderer = memo(function RichCardRenderer({
  cards,
}: {
  cards?: RichCardView[];
}) {
  if (!cards || cards.length === 0) return null;

  return (
    <div className="rich-cards-stack">
      {cards.map((card) => (
        <RichCard key={card.id} card={card} />
      ))}
    </div>
  );
});
