/**
 * RichTextValue — re-exported from @sunpilot/protocol as the single source of truth.
 * Local utilities (normalizeRichText) remain here for frontend rendering.
 */
export type { RichTextValue } from "@sunpilot/protocol";
import type { RichTextValue } from "@sunpilot/protocol";

/** Normalize a RichTextValue to a structured form */
export interface RichTextObject {
  text: string;
  format: "plain" | "markdown" | "auto";
  href?: string;
  tone?: "default" | "muted" | "success" | "warning" | "danger";
}

export function normalizeRichText(value: RichTextValue | undefined): RichTextObject | null {
  if (value == null) return null;
  if (typeof value === "string") {
    return { text: value, format: "auto" };
  }
  return {
    text: value.text,
    format: value.format ?? "auto",
    href: value.href,
    tone: value.tone,
  };
}
