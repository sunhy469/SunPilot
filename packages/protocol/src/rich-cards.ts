/**
 * Rich Card Protocol — shared schema for frontend and backend.
 *
 * This file is the single source of truth for Rich Card type definitions.
 * Both `@sunpilot/web` and `@sunpilot/core` should import from here.
 */

// ── RichTextValue ────────────────────────────────────────────────────

export type RichTextValue =
  | string
  | {
      text: string;
      format?: "plain" | "markdown" | "auto";
      href?: string;
      tone?: "default" | "muted" | "success" | "warning" | "danger";
    };

// ── Rich Card Type Registry ──────────────────────────────────────────

export type RichCardType =
  // ── Media & file cards ─────────────────────────────────────────────
  | "video"
  | "audio"
  | "image"
  | "gallery"
  | "file"
  | "file_bundle"
  | "pdf_preview"
  // ── Interactive cards ──────────────────────────────────────────────
  | "approval_summary"
  | "form_card"
  | "choice_group"
  | "rating_card"
  | "date_picker_card"
  | "action_list"
  // ── Chart / data visualization ────────────────────────────────────
  | "chart"
  | "bar_chart"
  | "pie_chart"
  | "line_chart"
  | "area_chart"
  | "scatter_chart"
  | "radar_chart"
  | "heatmap"
  | "stat_grid"
  | "kpi_card"
  | "product_grid"
  | "record_card"
  | "kanban"
  // ── System / tool cards ───────────────────────────────────────────
  | "tool_result"
  | "skill_result"
  | "diagnostic"
  | "status";

// ── Rich Card View ───────────────────────────────────────────────────

export interface RichCardView<TData = unknown> {
  id: string;
  type: RichCardType;
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: TData;
  version?: 1;
  layout?: {
    density?: "compact" | "comfortable";
    width?: "message" | "wide";
  };
  interaction?: RichCardInteraction;
  metadata?: {
    source?: "model" | "tool" | "artifact" | "markdown";
    runId?: string;
    toolCallId?: string;
    artifactIds?: string[];
  };
}

// ── Interaction Protocol ─────────────────────────────────────────────

export interface RichCardInteraction {
  mode?: "local" | "submit";
  actions?: Array<{
    type: string;
    label?: string;
  }>;
}

export type RichCardAction =
  | {
      type: "toggle_item";
      cardId: string;
      itemId: string;
      checked: boolean;
    }
  | {
      type: "submit";
      cardId: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "open_link";
      cardId: string;
      url: string;
    };

// ── Rich Card Output (backend → frontend) ───────────────────────────

export interface RichCardOutput {
  id: string;
  type: RichCardType;
  title?: RichTextValue;
  subtitle?: RichTextValue;
  data: Record<string, unknown>;
  version?: 1;
  layout?: RichCardView["layout"];
  interaction?: RichCardInteraction;
  metadata?: RichCardView["metadata"];
}
