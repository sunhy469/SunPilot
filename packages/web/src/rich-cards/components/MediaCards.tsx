import { Image, Typography } from "antd";
import type {
  CodeCardData,
  GalleryCardData,
  ImageCardData,
  MetricCardData,
  TimelineCardData,
  VideoCardData,
} from "../types";
import type { RichTextValue } from "../types";
import { RichCardShell } from "./RichCardShell";
import { RichTextRenderer } from "../richText";

const { Text } = Typography;

export function VideoCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
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
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: MetricCardData;
}) {
  const metrics = Array.isArray(data.metrics)
    ? data.metrics
    : [{ label: (data as any).label, value: (data as any).value, change: (data as any).change, tone: (data as any).tone }];

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-metrics">
        {metrics.map((metric) => (
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
  title?: RichTextValue;
  subtitle?: RichTextValue;
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
              {item.description && <RichTextRenderer value={item.description} inline={false} />}
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
  title?: RichTextValue;
  subtitle?: RichTextValue;
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
  title?: RichTextValue;
  subtitle?: RichTextValue;
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

export function ImageCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: ImageCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-image-card">
        <Image src={data.src} alt={data.alt ?? ""} className="rich-image-card__img" />
        {data.caption && <Text type="secondary" className="rich-image-card__caption">{data.caption}</Text>}
      </div>
    </RichCardShell>
  );
}
