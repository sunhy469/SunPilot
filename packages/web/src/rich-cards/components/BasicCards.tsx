import {
  DownloadOutlined,
  FileOutlined,
} from "@ant-design/icons";
import { Button, Typography } from "antd";
import type { RichTextValue } from "../types";
import { RichCardShell } from "./RichCardShell";

const { Text, Link } = Typography;

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
