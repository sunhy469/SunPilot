import type { ExtractedImage } from "./types";

const IMAGE_RE = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;

/**
 * Parse consecutive Markdown image lines starting at `startIndex`.
 * Returns extracted images and the index of the first non-image line.
 */
export function parseMarkdownImages(
  lines: string[],
  startIndex: number,
): { images: ExtractedImage[]; nextIndex: number } {
  const images: ExtractedImage[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const match = lines[i]?.match(IMAGE_RE);
    if (!match) break;
    images.push({
      alt: match[1] || undefined,
      src: match[2] ?? "",
      caption: match[1] || undefined,
    });
    i++;
  }

  return { images, nextIndex: i };
}
