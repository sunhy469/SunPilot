import { type ReactNode } from "react";

/** URL pattern that handles trailing punctuation correctly */
const URL_RE = /https?:\/\/[^\s<>\u4e00-\u9fff)\]}",;]+[^\s<>\u4e00-\u9fff)\]}",;.!?]/g;

/** Email pattern */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

/** Inline code pattern: `code` */
const INLINE_CODE_RE = /`([^`]+)`/g;

/** Markdown link pattern: [label](url) */
const MD_LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

export interface LinkifySegment {
  type: "text" | "url" | "email" | "code" | "link";
  content: string;
  href?: string;
}

/**
 * Parse a text string into segments of URLs, emails, inline code, markdown links, and plain text.
 * Processing order: markdown links first, then inline code, then URLs, then emails.
 */
export function linkify(text: string): LinkifySegment[] {
  if (!text) return [];

  // Phase 1: Extract markdown links and inline code, replacing with placeholders
  const placeholders: Array<{ placeholder: string; segment: LinkifySegment }> = [];
  let counter = 0;

  let processed = text;

  // Extract markdown links first
  processed = processed.replace(MD_LINK_RE, (match, label, url) => {
    const placeholder = `\x00LINK${counter}\x00`;
    placeholders.push({
      placeholder,
      segment: { type: "link", content: label, href: url },
    });
    counter++;
    return placeholder;
  });

  // Extract inline code
  processed = processed.replace(INLINE_CODE_RE, (match, code) => {
    const placeholder = `\x00CODE${counter}\x00`;
    placeholders.push({
      placeholder,
      segment: { type: "code", content: code },
    });
    counter++;
    return placeholder;
  });

  // Phase 2: Split remaining text by URLs and emails
  const segments: LinkifySegment[] = [];

  // Simple approach: iterate through the processed string
  const combinedRe = /(https?:\/\/[^\s\x00-\x1f<>\u4e00-\u9fff)\]}",;]+[^\s\x00-\x1f<>\u4e00-\u9fff)\]}",;.!?])|([\w.+-]+@[\w-]+\.[\w.-]+)/g;
  let match: RegExpExecArray | null;
  let searchFrom = 0;

  while ((match = combinedRe.exec(processed)) !== null) {
    // Add text before this match
    if (match.index > searchFrom) {
      const before = processed.slice(searchFrom, match.index);
      if (before) {
        segments.push(...resolvePlaceholders(before, placeholders));
      }
    }

    const matchedText = match[0];
    if (match[1]) {
      // URL match
      segments.push({ type: "url", content: matchedText, href: matchedText });
    } else if (match[2]) {
      // Email match
      segments.push({ type: "email", content: matchedText, href: `mailto:${matchedText}` });
    }

    searchFrom = match.index + matchedText.length;
  }

  // Add remaining text
  if (searchFrom < processed.length) {
    const remaining = processed.slice(searchFrom);
    if (remaining) {
      segments.push(...resolvePlaceholders(remaining, placeholders));
    }
  }

  return segments;
}

function resolvePlaceholders(
  text: string,
  placeholders: Array<{ placeholder: string; segment: LinkifySegment }>,
): LinkifySegment[] {
  const segments: LinkifySegment[] = [];
  let remaining = text;

  for (const { placeholder, segment } of placeholders) {
    const idx = remaining.indexOf(placeholder);
    if (idx === -1) continue;

    if (idx > 0) {
      segments.push({ type: "text", content: remaining.slice(0, idx) });
    }
    segments.push(segment);
    remaining = remaining.slice(idx + placeholder.length);
  }

  if (remaining) {
    segments.push({ type: "text", content: remaining });
  }

  return segments;
}

/**
 * Convert linkify segments to React nodes.
 */
export function linkifyToNodes(
  segments: LinkifySegment[],
  keyPrefix = "lk",
): ReactNode[] {
  return segments.map((seg, i) => {
    const key = `${keyPrefix}_${i}`;
    switch (seg.type) {
      case "url":
      case "email":
        return (
          <a key={key} href={seg.href} target="_blank" rel="noopener noreferrer" className="rich-text-link">
            {seg.content}
          </a>
        );
      case "link":
        return (
          <a key={key} href={seg.href} target="_blank" rel="noopener noreferrer" className="rich-text-link">
            {seg.content}
          </a>
        );
      case "code":
        return (
          <code key={key} className="rich-text-inline-code">
            {seg.content}
          </code>
        );
      case "text":
      default:
        return <span key={key}>{seg.content}</span>;
    }
  });
}
