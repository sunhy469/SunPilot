import {
  DownloadOutlined,
  ExclamationCircleOutlined,
  FileOutlined,
  InfoCircleOutlined,
} from "@ant-design/icons";
import { Alert, Button, Typography } from "antd";
import type { RichTextValue } from "../types";
import { RichCardShell } from "./RichCardShell";
import { RichTextRenderer } from "../richText";

const { Text, Link } = Typography;

export function SummaryCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: { text: string };
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <RichTextRenderer value={data.text} inline={false} />
    </RichCardShell>
  );
}

export function InfoCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: { text: string };
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--info">
      <Alert
        type="info"
        showIcon
        icon={<InfoCircleOutlined />}
        message={<RichTextRenderer value={data.text} inline={false} />}
      />
    </RichCardShell>
  );
}

export function ErrorCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: { text?: string; message?: string };
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--error">
      <Alert
        type="error"
        showIcon
        icon={<ExclamationCircleOutlined />}
        message={data.message ?? data.text ?? "发生未知错误"}
      />
    </RichCardShell>
  );
}

export function FileCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: { fileName?: string; fileSize?: string; href?: string };
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle} className="rich-card--file">
      <div className="rich-file">
        <div className="rich-file__icon">
          <FileOutlined />
        </div>
        <div className="rich-file__meta">
          <Text strong>{data.fileName ?? (typeof title === "string" ? title : title?.text ?? "文件")}</Text>
          {data.fileSize && <Text type="secondary"> {data.fileSize}</Text>}
        </div>
        {data.href ? (
          <Link href={data.href} download>
            <Button
              type="text"
              icon={<DownloadOutlined />}
              aria-label="下载"
              size="small"
            />
          </Link>
        ) : (
          <Button
            type="text"
            icon={<DownloadOutlined />}
            aria-label="下载"
            size="small"
          />
        )}
      </div>
    </RichCardShell>
  );
}
