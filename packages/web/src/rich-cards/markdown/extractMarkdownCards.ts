import type { ExtractedContent } from "./types";
import type { RichCardView } from "../types";
import { parseMarkdownTable } from "./parseMarkdownTable";
import { parseMarkdownImages } from "./parseMarkdownImages";
import { parseMarkdownTaskList } from "./parseMarkdownTaskList";

const BARE_URL_RE = /^https?:\/\/[^\s]+$/;
const FENCED_CODE_RE = /^```(\w*)$/;
const SUNPILOT_CARD_RE = /^```sunpilot-card$/;

/**
 * Validate and parse a sunpilot-card DSL block.
 * Returns a valid RichCardView or null if parsing fails.
 */
function parseCardDsl(jsonStr: string): RichCardView | null {
  try {
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.type || !parsed.data) return null;
    if (typeof parsed.type !== "string") return null;
    return {
      id: parsed.id ?? `dsl_${parsed.type}_${Date.now()}`,
      type: parsed.type,
      title: parsed.title,
      subtitle: parsed.subtitle,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

/**
 * Extract structured content (tables, images, task lists, URLs, code blocks, card DSL)
 * from completed Markdown content.
 *
 * Returns extracted items as Rich Card data alongside the remaining Markdown text.
 */
export function extractMarkdownCards(markdown: string): ExtractedContent {
  const tables: ExtractedContent["tables"] = [];
  const images: ExtractedContent["images"] = [];
  const checklists: ExtractedContent["checklists"] = [];
  const linkPreviews: ExtractedContent["linkPreviews"] = [];
  const codeBlocks: ExtractedContent["codeBlocks"] = [];
  const cardDslCards: ExtractedContent["cardDslCards"] = [];
  const remainingLines: string[] = [];

  const lines = markdown.split("\n");
  let i = 0;

  while (i < lines.length) {
    // ── Table extraction ──
    const tableResult = parseMarkdownTable(lines, i);
    if (tableResult) {
      tables.push(tableResult.table);
      i = tableResult.nextIndex;
      continue;
    }

    // ── Image extraction (consecutive) ──
    const imageResult = parseMarkdownImages(lines, i);
    if (imageResult.images.length > 0) {
      images.push(...imageResult.images);
      i = imageResult.nextIndex;
      continue;
    }

    // ── Task list extraction ──
    const taskResult = parseMarkdownTaskList(lines, i);
    if (taskResult.items.length > 0) {
      checklists.push({ items: taskResult.items });
      i = taskResult.nextIndex;
      continue;
    }

    // ── Bare URL extraction ──
    const trimmedLine = lines[i]?.trim();
    if (trimmedLine && BARE_URL_RE.test(trimmedLine)) {
      linkPreviews.push({ url: trimmedLine });
      i++;
      continue;
    }

    // ── sunpilot-card DSL extraction ──
    if (SUNPILOT_CARD_RE.test(lines[i]?.trim() ?? "")) {
      const dslLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]?.startsWith("```")) {
        dslLines.push(lines[j]!);
        j++;
      }
      if (j < lines.length) j++; // skip closing ```
      const card = parseCardDsl(dslLines.join("\n"));
      if (card) {
        cardDslCards.push(card);
      } else {
        // Fallback: render as plain code block
        codeBlocks.push({ language: "sunpilot-card", code: dslLines.join("\n") });
      }
      i = j;
      continue;
    }

    // ── Fenced code block extraction ──
    const codeMatch = lines[i]?.match(FENCED_CODE_RE);
    if (codeMatch) {
      const lang = codeMatch[1] || undefined;
      const codeLines: string[] = [];
      let j = i + 1;
      while (j < lines.length && !lines[j]?.startsWith("```")) {
        codeLines.push(lines[j]!);
        j++;
      }
      if (j < lines.length) j++;
      codeBlocks.push({ language: lang, code: codeLines.join("\n") });
      i = j;
      continue;
    }

    const currentLine = lines[i];
    if (currentLine !== undefined) {
      remainingLines.push(currentLine);
    }
    i++;
  }

  return {
    tables,
    images,
    checklists,
    linkPreviews,
    codeBlocks,
    cardDslCards,
    remainingMarkdown: remainingLines.join("\n"),
  };
}
