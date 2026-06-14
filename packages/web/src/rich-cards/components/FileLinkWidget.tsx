import { memo } from "react";
import { Card, Typography, Flex, Button, Tag } from "antd";
import {
  FileOutlined,
  DownloadOutlined,
  EyeOutlined,
  FilePdfOutlined,
  FileImageOutlined,
  FileTextOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FileZipOutlined,
  FileUnknownOutlined,
  LinkOutlined,
} from "@ant-design/icons";

const { Text } = Typography;

// ── Types ─────────────────────────────────────────────────────────────

export type FileTypeHint =
  | "pdf"
  | "image"
  | "text"
  | "spreadsheet"
  | "presentation"
  | "archive"
  | "code"
  | "video"
  | "audio"
  | "unknown";

export interface FileLinkWidgetProps {
  /** File name (required) */
  fileName: string;
  /** Optional file size string, e.g. "2.3 MB" */
  fileSize?: string;
  /** Optional URL to open/download the file */
  url?: string;
  /** Optional hint for file type icon */
  fileType?: FileTypeHint;
  /** Optional description or summary */
  description?: string;
  /** Card title */
  title?: string;
  /** Card subtitle */
  subtitle?: string;
}

// ── File type config ──────────────────────────────────────────────────

const FILE_TYPE_ICONS: Record<FileTypeHint, React.ReactNode> = {
  pdf: <FilePdfOutlined style={{ color: "#ef4444", fontSize: 20 }} />,
  image: <FileImageOutlined style={{ color: "#8b5cf6", fontSize: 20 }} />,
  text: <FileTextOutlined style={{ color: "#2563eb", fontSize: 20 }} />,
  spreadsheet: <FileExcelOutlined style={{ color: "#10b981", fontSize: 20 }} />,
  presentation: <FilePptOutlined style={{ color: "#f59e0b", fontSize: 20 }} />,
  archive: <FileZipOutlined style={{ color: "#6b7280", fontSize: 20 }} />,
  code: <FileTextOutlined style={{ color: "#06b6d4", fontSize: 20 }} />,
  video: <FileOutlined style={{ color: "#f472b6", fontSize: 20 }} />,
  audio: <FileOutlined style={{ color: "#f472b6", fontSize: 20 }} />,
  unknown: <FileUnknownOutlined style={{ color: "#6b7280", fontSize: 20 }} />,
};

const FILE_TYPE_LABELS: Record<FileTypeHint, string> = {
  pdf: "PDF",
  image: "图片",
  text: "文本",
  spreadsheet: "表格",
  presentation: "演示文稿",
  archive: "压缩包",
  code: "代码",
  video: "视频",
  audio: "音频",
  unknown: "文件",
};

function guessFileType(fileName: string): FileTypeHint {
  const ext = fileName.split(".").pop()?.toLowerCase();
  if (!ext) return "unknown";
  const map: Record<string, FileTypeHint> = {
    pdf: "pdf",
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    svg: "image",
    webp: "image",
    txt: "text",
    md: "text",
    markdown: "text",
    log: "text",
    csv: "spreadsheet",
    xlsx: "spreadsheet",
    xls: "spreadsheet",
    pptx: "presentation",
    ppt: "presentation",
    zip: "archive",
    tar: "archive",
    gz: "archive",
    rar: "archive",
    "7z": "archive",
    ts: "code",
    tsx: "code",
    js: "code",
    jsx: "code",
    py: "code",
    rs: "code",
    go: "code",
    java: "code",
    json: "code",
    yaml: "code",
    yml: "code",
    toml: "code",
    mp4: "video",
    mov: "video",
    webm: "video",
    mp3: "audio",
    wav: "audio",
    ogg: "audio",
  };
  return map[ext] || "unknown";
}

// ── Component ─────────────────────────────────────────────────────────

export const FileLinkWidget = memo(function FileLinkWidget({
  fileName,
  fileSize,
  url,
  fileType,
  description,
  title,
  subtitle,
}: FileLinkWidgetProps) {
  const type = fileType || guessFileType(fileName);
  const icon = FILE_TYPE_ICONS[type];
  const typeLabel = FILE_TYPE_LABELS[type];

  const content = (
    <Flex
      className="file-link-widget"
      align="center"
      gap={12}
      style={{
        padding: "12px 16px",
        borderRadius: 12,
        border: "1px solid var(--sp-border)",
        background: "var(--sp-surface-soft)",
      }}
    >
      <div className="file-link-widget__icon">{icon}</div>
      <Flex vertical flex={1} style={{ minWidth: 0 }}>
        <Text strong ellipsis className="file-link-widget__name">
          {fileName}
        </Text>
        <Flex gap={8} align="center">
          <Tag color="default" style={{ fontSize: 11 }}>
            {typeLabel}
          </Tag>
          {fileSize && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {fileSize}
            </Text>
          )}
        </Flex>
        {description && (
          <Text
            type="secondary"
            style={{
              fontSize: 12,
              marginTop: 4,
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {description}
          </Text>
        )}
      </Flex>
      <Flex gap={4} className="file-link-widget__actions">
        {url && (
          <>
            <Button
              type="text"
              size="small"
              icon={<EyeOutlined />}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
            >
              查看
            </Button>
            <Button
              type="text"
              size="small"
              icon={<DownloadOutlined />}
              href={url}
              download={fileName}
            >
              下载
            </Button>
          </>
        )}
        {!url && (
          <Button type="text" size="small" icon={<LinkOutlined />} disabled>
            无链接
          </Button>
        )}
      </Flex>
    </Flex>
  );

  if (title) {
    return (
      <Card title={title} size="small" className="file-link-card">
        {subtitle && (
          <Text
            type="secondary"
            style={{ display: "block", margin: "0 0 12px 0" }}
          >
            {subtitle}
          </Text>
        )}
        {content}
      </Card>
    );
  }

  return content;
});

export default FileLinkWidget;
