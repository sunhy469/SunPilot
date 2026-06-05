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
      <div className="rich-table-wrap">
        <table className="rich-table">
          <thead>
            <tr>
              {data.columns.map((column) => (
                <th key={column.key}>{column.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, idx) => (
              <tr key={idx}>
                {data.columns.map((column) => (
                  <td key={column.key}>{row[column.key]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </RichCardShell>
  );
}
