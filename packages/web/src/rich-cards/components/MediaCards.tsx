import type {
  CodeCardData,
  GalleryCardData,
  MetricCardData,
  TimelineCardData,
  VideoCardData,
} from "../types";
import { RichCardShell } from "./RichCardShell";

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
      {data.caption && <p className="rich-card__caption">{data.caption}</p>}
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
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
            {metric.change && <em>{metric.change}</em>}
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
              <strong>{item.title}</strong>
              {item.time && <em>{item.time}</em>}
              {item.description && <p>{item.description}</p>}
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
        <span>{data.fileName ?? "snippet"}</span>
        {data.language && <b>{data.language}</b>}
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
      <div className="rich-gallery">
        {data.images.map((image) => (
          <figure key={image.src}>
            <img src={image.src} alt={image.alt ?? ""} />
            {image.caption && <figcaption>{image.caption}</figcaption>}
          </figure>
        ))}
      </div>
    </RichCardShell>
  );
}
