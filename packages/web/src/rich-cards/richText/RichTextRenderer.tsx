import { type ReactNode, useMemo } from "react";
import { Typography } from "antd";
import type { RichTextValue } from "./types";
import { normalizeRichText } from "./types";
import { linkify, linkifyToNodes } from "./linkify";

const { Text } = Typography;

const TONE_MAP: Record<string, "default" | "secondary" | "success" | "warning" | "danger"> = {
  default: "default",
  muted: "secondary",
  success: "success",
  warning: "warning",
  danger: "danger",
};

/**
 * RichTextRenderer — renders RichTextValue with link detection and formatting.
 *
 * Rendering priority:
 * 1. `href` present → render as link
 * 2. `format: "markdown"` → limited markdown rendering (links, bold, inline code)
 * 3. `format: "auto"` or plain string → auto-detect bare URLs, markdown links, emails, inline code
 * 4. `format: "plain"` → plain text, no linkification
 */
export function RichTextRenderer({
  value,
  inline = true,
}: {
  value?: RichTextValue;
  inline?: boolean;
}): ReactNode {
  const normalized = useMemo(() => normalizeRichText(value), [value]);
  const text = normalized?.text ?? "";
  // Hooks must be called at top level, not inside conditionals
  const segments = useMemo(() => linkify(text), [text]);

  if (!normalized) return null;

  const { format, href, tone } = normalized;

  // Case 1: explicit href → render as link
  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="rich-text-link">
        {text}
      </a>
    );
  }

  // Case 2: plain format → no processing
  if (format === "plain") {
    const content = <>{text}</>;
    return tone && tone !== "default" ? (
      <Text type={TONE_MAP[tone]}>{content}</Text>
    ) : (
      content
    );
  }

  // Case 3 & 4: markdown or auto format → linkify
  if (format === "markdown" || format === "auto") {
    const nodes = linkifyToNodes(segments);

    const content = <>{nodes}</>;
    return tone && tone !== "default" ? (
      <Text type={TONE_MAP[tone]}>{content}</Text>
    ) : (
      content
    );
  }

  return <>{text}</>;
}
