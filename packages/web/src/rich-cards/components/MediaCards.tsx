import { Image, Typography } from "antd";
import type {
  CodeCardData,
  GalleryCardData,
  MetricCardData,
  TimelineCardData,
  VideoCardData,
} from "../types";
import { RichCardShell } from "./RichCardShell";

const { Text, Paragraph } = Typography;

export function VideoCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: VideoCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--video">
      <video className="rich-video" src={data.src} poster={data.poster} controls />
      {data.caption && <Text type="secondary">{data.caption}</Text>}
    </RichCardShell>
  );
}

export function MetricCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: MetricCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-metrics">
        {data.metrics.map((metric) => (
          <div key={metric.label} className={`rich-metric is-${metric.tone ?? "blue"}`}>
            <Text>{metric.label}</Text>
            <Text strong>{metric.value}</Text>
            {metric.change && <Text type="secondary">{metric.change}</Text>}
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

export function TimelineCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: TimelineCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-timeline">
        {data.items.map((item, idx) => (
          <div key={`${item.title}-${idx}`} className={`rich-timeline__item is-${item.status ?? "pending"}`}>
            <span className="rich-timeline__pin" />
            <div>
              <Text strong>{item.title}</Text>
              {item.time && <Text type="secondary"> {item.time}</Text>}
              {item.description && <Paragraph>{item.description}</Paragraph>}
            </div>
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

export function CodeCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: CodeCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--code">
      <div className="rich-code__bar">
        <Text>{data.fileName ?? "snippet"}</Text>
        {data.language && <Text strong> {data.language}</Text>}
      </div>
      <pre className="rich-code"><code>{data.code}</code></pre>
    </RichCardShell>
  );
}

export function GalleryCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: GalleryCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <Image.PreviewGroup>
        <div className="rich-gallery">
          {data.images.map((image) => (
            <div key={image.src} className="rich-gallery__item">
              <Image src={image.src} alt={image.alt ?? ""} />
              {image.caption && <Text type="secondary" className="rich-gallery__caption">{image.caption}</Text>}
            </div>
          ))}
        </div>
      </Image.PreviewGroup>
    </RichCardShell>
  );
}
