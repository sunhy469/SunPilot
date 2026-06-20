import type { TableCardData } from "../types";

/**
 * Parse a Markdown table from lines starting at `startIndex`.
 * Returns the parsed table and the index of the first line after the table.
 */
export function parseMarkdownTable(
  lines: string[],
  startIndex: number,
): { table: TableCardData; nextIndex: number } | null {
  const line = lines[startIndex];
  if (!line || !line.includes("|")) return null;

  const nextLine = startIndex + 1 < lines.length ? lines[startIndex + 1] : undefined;
  if (!nextLine || !/^\|?\s*[-:]+[-|\s:]*$/.test(nextLine)) return null;

  const headers = line
    .split("|")
    .map((c) => c.trim())
    .filter(Boolean);

  const dataLines: string[] = [];
  let j = startIndex + 2;

  while (j < lines.length && lines[j]?.includes("|")) {
    dataLines.push(lines[j]!);
    j++;
  }

  const rows = dataLines.map((dataLine) => {
    const cells = dataLine
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    const row: Record<string, string | number> = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? "";
    });
    return row;
  });

  if (headers.length === 0 || rows.length === 0) return null;

  return {
    table: {
      columns: headers.map((h) => ({ key: h, label: h })),
      rows,
    },
    nextIndex: j,
  };
}
