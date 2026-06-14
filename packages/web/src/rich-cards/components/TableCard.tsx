import { Table } from "antd";
import type { TableCardData } from "../types";
import { RichCardShell } from "./RichCardShell";

export function TableCard({
  title,
  subtitle,
  data,
}: {
  title?: string;
  subtitle?: string;
  data: TableCardData;
}) {
  return (
    <RichCardShell title={title} subtitle={subtitle}>
      <Table
        size="small"
        columns={data.columns.map((col) => ({
          key: col.key,
          title: col.label,
          dataIndex: col.key,
        }))}
        dataSource={data.rows.map((row, idx) => ({ key: idx, ...row }))}
        pagination={false}
      />
    </RichCardShell>
  );
}
