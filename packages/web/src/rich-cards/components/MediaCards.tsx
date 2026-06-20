import { Image, Typography } from "antd";
import type {
  GalleryCardData,
  ImageCardData,
  VideoCardData,
} from "../types";
import type { RichTextValue } from "../types";
import { RichCardShell } from "./RichCardShell";

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
