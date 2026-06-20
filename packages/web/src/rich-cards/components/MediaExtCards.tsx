import { useState } from "react";
import {
  DownloadOutlined,
  FileOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  SoundOutlined,
  FileTextOutlined,
  FilterOutlined,
} from "@ant-design/icons";
import { Button, Typography, Tag, Input, Flex } from "antd";
import type {
  AudioCardData,
  FileBundleCardData,
  PdfPreviewCardData,
  RecordCardData,
  ProductGridCardData,
} from "../types";
import type { RichTextValue } from "../types";
import { RichCardShell } from "./RichCardShell";
import { RichTextRenderer } from "../richText";

const { Text, Paragraph } = Typography;

// ── AudioCard ────────────────────────────────────────────────────────

export function AudioCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: AudioCardData;
}) {
  return (
    <RichCardShell title={title ?? data.title} subtitle={subtitle} className="rich-card--audio">
      <div className="rich-audio">
        <audio src={data.src} controls className="rich-audio__player" />
        {data.duration != null && (
          <Text type="secondary" className="rich-audio__duration">
            时长: {Math.floor(data.duration / 60)}:{String(Math.floor(data.duration % 60)).padStart(2, "0")}
          </Text>
        )}
        {data.transcript && (
          <details className="rich-audio__transcript">
            <summary>
              <Text type="secondary">转写文本</Text>
            </summary>
            <Paragraph type="secondary" style={{ marginTop: 8, fontSize: 13 }}>
              {data.transcript}
            </Paragraph>
          </details>
        )}
      </div>
    </RichCardShell>
  );
}

// ── FileBundleCard ───────────────────────────────────────────────────

export function FileBundleCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: FileBundleCardData;
}) {
  const [filter, setFilter] = useState<string>("all");
  const types = ["all", ...new Set(data.files.map((f) => f.type ?? "other"))];
  const filtered = filter === "all" ? data.files : data.files.filter((f) => (f.type ?? "other") === filter);

  return (
    <RichCardShell title={title ?? "文件列表"} subtitle={subtitle}>
      <div className="rich-file-bundle">
        {types.length > 1 && (
          <div className="rich-file-bundle__filters">
            {types.map((t) => (
              <Tag
                key={t}
                color={filter === t ? "blue" : undefined}
                style={{ cursor: "pointer" }}
                onClick={() => setFilter(t)}
              >
                {t === "all" ? "全部" : t}
              </Tag>
            ))}
          </div>
        )}
        <div className="rich-file-bundle__list">
          {filtered.map((file, idx) => (
            <div key={`${file.name}-${idx}`} className="rich-file-bundle__item">
              <FileOutlined style={{ color: "#f59e0b", fontSize: 16 }} />
              <div className="rich-file-bundle__meta">
                <Text>{file.name}</Text>
                {file.size && <Text type="secondary"> {file.size}</Text>}
              </div>
              {file.href && (
                <a href={file.href} download target="_blank" rel="noopener noreferrer">
                  <Button type="text" size="small" icon={<DownloadOutlined />} />
                </a>
              )}
            </div>
          ))}
        </div>
      </div>
    </RichCardShell>
  );
}

// ── PdfPreviewCard ───────────────────────────────────────────────────

export function PdfPreviewCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: PdfPreviewCardData;
}) {
  return (
    <RichCardShell title={title ?? data.title} subtitle={subtitle}>
      <div className="rich-pdf-preview">
        <iframe
          src={data.src}
          className="rich-pdf-preview__iframe"
          title={typeof title === "string" ? title : title?.text ?? "PDF 预览"}
        />
        <div className="rich-pdf-preview__actions">
          {data.pages && <Text type="secondary">{data.pages} 页</Text>}
          <a href={data.src} target="_blank" rel="noopener noreferrer">
            <Button type="link" size="small">打开</Button>
          </a>
          <a href={data.src} download>
            <Button type="link" size="small">下载</Button>
          </a>
        </div>
      </div>
    </RichCardShell>
  );
}

// ── RecordCard ───────────────────────────────────────────────────────

export function RecordCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: RecordCardData;
}) {
  return (
    <RichCardShell title={title ?? data.title} subtitle={subtitle}>
      <div className="rich-record">
        {data.fields.map((field) => (
          <div key={field.key} className="rich-record__field">
            <Text type="secondary" className="rich-record__label">{field.label}</Text>
            {field.type === "link" ? (
              <a href={field.value} target="_blank" rel="noopener noreferrer" className="rich-text-link">{field.value}</a>
            ) : field.type === "code" ? (
              <code className="rich-text-inline-code">{field.value}</code>
            ) : field.type === "badge" ? (
              <Tag>{field.value}</Tag>
            ) : (
              <Text>{field.value}</Text>
            )}
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}

// ── ProductGridCard ──────────────────────────────────────────────────

export function ProductGridCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: ProductGridCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <div className="rich-product-grid">
        {data.items.map((item, idx) => (
          <div key={`${item.title}-${idx}`} className="rich-product-grid__item">
            {item.image && (
              <img src={item.image} alt={item.title} className="rich-product-grid__image" />
            )}
            <div className="rich-product-grid__info">
              <Text strong>{item.title}</Text>
              {item.price && <Text type="success">{item.price}</Text>}
              {item.badge && <Tag color="blue">{item.badge}</Tag>}
              {item.description && (
                <Text type="secondary" ellipsis style={{ fontSize: 12 }}>
                  {item.description}
                </Text>
              )}
            </div>
            {item.url && (
              <a href={item.url} target="_blank" rel="noopener noreferrer">
                <Button type="link" size="small">查看</Button>
              </a>
            )}
          </div>
        ))}
      </div>
    </RichCardShell>
  );
}
