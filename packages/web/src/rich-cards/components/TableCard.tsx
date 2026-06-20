import { Table, Tag, Image, Button, Space, Tooltip } from "antd";
import type { TableCardData } from "../types";
import { RichCardShell } from "./RichCardShell";
import { RichTextRenderer } from "../richText";
import type { RichTextValue } from "../types";

export function TableCard({
  title,
  subtitle,
  data,
}: {
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: TableCardData;
}) {
  const columns = data.columns.map((col) => {
    const colType = col.type ?? "text";
    const isSortable = col.sortable ?? false;

    return {
      key: col.key,
      title: <RichTextRenderer value={col.label} inline={true} />,
      dataIndex: col.key,
      width: col.width,
      sorter: isSortable
        ? (a: Record<string, unknown>, b: Record<string, unknown>) => {
            const va = a[col.key];
            const vb = b[col.key];
            if (typeof va === "number" && typeof vb === "number") return va - vb;
            return String(va ?? "").localeCompare(String(vb ?? ""));
          }
        : undefined,
      render: (value: unknown) => renderCell(value, colType),
    };
  });

  const pagination =
    data.pagination === false
      ? false
      : data.pagination
        ? { pageSize: data.pagination.pageSize ?? 10, size: "small" as const }
        : false;

  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <Table
        size="small"
        columns={columns}
        dataSource={data.rows.map((row, idx) => ({ key: idx, ...row }))}
        pagination={pagination}
        scroll={{ x: "max-content" }}
      />
    </RichCardShell>
  );
}

function renderCell(value: unknown, colType: string) {
  if (value == null) return "-";

  switch (colType) {
    case "number":
      return <span style={{ textAlign: "right", display: "block" }}>{String(value)}</span>;

    case "link": {
      if (typeof value === "string") {
        return (
          <a href={value} target="_blank" rel="noopener noreferrer" className="rich-text-link">
            {value}
          </a>
        );
      }
      if (typeof value === "object" && value !== null) {
        const obj = value as { text?: string; href?: string };
        return (
          <a href={obj.href ?? "#"} target="_blank" rel="noopener noreferrer" className="rich-text-link">
            {obj.text ?? obj.href ?? "-"}
          </a>
        );
      }
      return String(value);
    }

    case "markdown":
      return <RichTextRenderer value={value as RichTextValue} inline={true} />;

    case "badge": {
      const str = String(value);
      const tone = getBadgeTone(str);
      return <Tag color={tone}>{str}</Tag>;
    }

    case "image": {
      const src = String(value);
      return <Image src={src} alt="" width={48} height={48} style={{ objectFit: "cover", borderRadius: 6 }} />;
    }

    case "text":
    default:
      return <RichTextRenderer value={value as RichTextValue} inline={true} />;
  }
}

function getBadgeTone(value: string): string {
  const lower = value.toLowerCase();
  if (["success", "ok", "done", "active", "completed", "passed", "通过", "成功", "完成"].includes(lower)) return "green";
  if (["error", "fail", "failed", "error", "错误", "失败"].includes(lower)) return "red";
  if (["warning", "warn", "pending", "警告", "待处理"].includes(lower)) return "orange";
  if (["info", "running", "信息", "运行中"].includes(lower)) return "blue";
  return "default";
}
