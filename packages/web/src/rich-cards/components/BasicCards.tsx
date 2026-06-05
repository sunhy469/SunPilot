import {
  DownloadOutlined,
  ExclamationCircleOutlined,
  FileOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { RichCardShell } from "./RichCardShell";

export function SummaryCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: { text: string };
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <p className="rich-card__text">{data.text}</p>
    </RichCardShell>
  );
}

export function InfoCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: { text: string };
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--info">
      <div className="rich-callout">
        <InfoCircleOutlined />
        <p>{data.text}</p>
      </div>
    </RichCardShell>
  );
}

export function ErrorCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: { text?: string; message?: string };
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--error">
      <div className="rich-callout">
        <ExclamationCircleOutlined />
        <p>{data.message ?? data.text ?? "发生未知错误"}</p>
      </div>
    </RichCardShell>
  );
}

export function FileCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: { fileName?: string; fileSize?: string; href?: string };
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--file">
      <div className="rich-file">
        <div className="rich-file__icon">
          <FileOutlined />
        </div>
        <div className="rich-file__meta">
          <strong>{data.fileName ?? title ?? "文件"}</strong>
          {data.fileSize && <span>{data.fileSize}</span>}
        </div>
        {data.href ? (
          <a
            className="rich-file__action sp-icon-button sp-icon-button--md sp-icon-button--muted"
            href={data.href}
            aria-label="下载"
            download
          >
            <DownloadOutlined />
          </a>
        ) : (
          <button
            type="button"
            className="rich-file__action sp-icon-button sp-icon-button--md sp-icon-button--muted"
            aria-label="下载"
          >
            <DownloadOutlined />
          </button>
        )}
      </div>
    </RichCardShell>
  );
}
