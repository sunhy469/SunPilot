import type { ExtractedChecklistItem } from "./types";

const TASK_ITEM_RE = /^[\s]*[-*]\s*\[([ xX])\]\s+(.+)$/;

/**
 * Parse consecutive Markdown task list items starting at `startIndex`.
 * Returns extracted items and the index of the first non-task line.
 */
export function parseMarkdownTaskList(
  lines: string[],
  startIndex: number,
): { items: ExtractedChecklistItem[]; nextIndex: number } {
  const items: ExtractedChecklistItem[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const match = lines[i]?.match(TASK_ITEM_RE);
    if (!match) break;
    const checked = match[1] !== " ";
    const label = match[2]?.trim() ?? "";
    items.push({
      id: `task_${i}`,
      label,
      checked,
    });
    i++;
  }

  return { items, nextIndex: i };
}
