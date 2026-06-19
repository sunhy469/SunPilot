/**
 * RichCardBuilder — unified builder for rich card data.
 *
 * Generates RichCardView-compatible objects from artifacts, tool outputs,
 * and skill results. Every card includes an `id` field for frontend rendering.
 *
 * Replaces the narrow `buildStreamingRichCards()` in ToolDecisionEngine.
 */

export interface RichCardInput {
  type: string;
  name: string;
  url?: string;
  /** For structured results (products, search results, etc.) */
  data?: Record<string, unknown>;
}

export interface RichCardOutput {
  id: string;
  type: string;
  title?: string;
  subtitle?: string;
  data: Record<string, unknown>;
}

export class RichCardBuilder {
  private cards: RichCardOutput[] = [];

  /**
   * Build cards from artifacts (video, image, file, etc.)
   */
  fromArtifacts(artifacts: RichCardInput[]): this {
    const images: RichCardInput[] = [];
    const others: RichCardInput[] = [];

    for (const a of artifacts) {
      if (a.type === "image") {
        images.push(a);
      } else {
        others.push(a);
      }
    }

    // Group images into a gallery card if multiple, individual cards if single
    if (images.length > 1) {
      this.cards.push({
        id: `card_gallery_${this.cards.length}`,
        type: "gallery",
        title: "图片资源",
        data: {
          items: images.map((img, i) => ({
            src: img.url ?? "",
            caption: img.name,
            alt: img.name,
          })),
        },
      });
    } else if (images.length === 1) {
      const img = images[0]!;
      this.cards.push({
        id: `card_image_${this.cards.length}`,
        type: "image",
        title: img.name,
        data: {
          src: img.url ?? "",
          caption: img.name,
        },
      });
    }

    // Handle other artifact types
    for (const a of others) {
      switch (a.type) {
        case "video":
          this.cards.push({
            id: `card_video_${this.cards.length}`,
            type: "video",
            title: a.name,
            data: {
              src: a.url ?? "",
              caption: a.name,
            },
          });
          break;
        case "file":
          this.cards.push({
            id: `card_file_${this.cards.length}`,
            type: "file",
            title: a.name,
            data: {
              fileName: a.name,
              href: a.url ?? "",
            },
          });
          break;
        default:
          // Generic info card for unknown artifact types
          this.cards.push({
            id: `card_info_${this.cards.length}`,
            type: "info",
            title: a.name,
            data: {
              text: a.url ?? a.name,
            },
          });
      }
    }

    return this;
  }

  /**
   * Build a table card from structured data (e.g., product search results)
   */
  fromTable(input: {
    title?: string;
    subtitle?: string;
    columns: Array<{ key: string; label: string }>;
    rows: Array<Record<string, unknown>>;
  }): this {
    this.cards.push({
      id: `card_table_${this.cards.length}`,
      type: "table",
      title: input.title,
      subtitle: input.subtitle,
      data: {
        columns: input.columns,
        rows: input.rows,
      },
    });
    return this;
  }

  /**
   * Build a tool_result card
   */
  fromToolResult(input: {
    title?: string;
    toolName: string;
    status: string;
    toolCallId?: string;
    summary?: string;
    detail?: string;
    error?: string;
    durationMs?: number;
    timestamp?: string;
  }): this {
    this.cards.push({
      id: `card_tool_result_${this.cards.length}`,
      type: "tool_result",
      title: input.title,
      data: {
        toolName: input.toolName,
        status: input.status,
        toolCallId: input.toolCallId ?? "",
        summary: input.summary ?? "",
        detail: input.detail,
        error: input.error,
        durationMs: input.durationMs,
        timestamp: input.timestamp,
      },
    });
    return this;
  }

  /**
   * Build a skill_result card
   */
  fromSkillResult(input: {
    title?: string;
    skillName: string;
    status: string;
    skillId?: string;
    steps?: number;
    summary?: string;
    detail?: string;
    error?: string;
    durationMs?: number;
    timestamp?: string;
  }): this {
    this.cards.push({
      id: `card_skill_result_${this.cards.length}`,
      type: "skill_result",
      title: input.title,
      data: {
        skillName: input.skillName,
        status: input.status,
        skillId: input.skillId ?? "",
        steps: input.steps,
        summary: input.summary ?? "",
        detail: input.detail,
        error: input.error,
        durationMs: input.durationMs,
        timestamp: input.timestamp,
      },
    });
    return this;
  }

  /**
   * Build a link_preview card
   */
  fromLinkPreview(input: {
    title?: string;
    url: string;
    description?: string;
  }): this {
    this.cards.push({
      id: `card_link_preview_${this.cards.length}`,
      type: "link_preview",
      title: input.title,
      data: {
        title: input.title ?? "",
        url: input.url,
        description: input.description,
      },
    });
    return this;
  }

  /**
   * Build a metric card
   */
  fromMetric(input: {
    title?: string;
    label: string;
    value: string | number;
    change?: string;
    trend?: "up" | "down" | "flat";
  }): this {
    this.cards.push({
      id: `card_metric_${this.cards.length}`,
      type: "metric",
      title: input.title,
      data: {
        label: input.label,
        value: String(input.value),
        change: input.change,
        trend: input.trend,
      },
    });
    return this;
  }

  /**
   * Return all built cards and reset the builder.
   */
  build(): RichCardOutput[] {
    const result = this.cards;
    this.cards = [];
    return result;
  }
}
