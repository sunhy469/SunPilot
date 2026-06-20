/**
 * RichCardBuilder — unified builder for rich card data.
 *
 * Generates RichCardView-compatible objects from artifacts, tool outputs,
 * and skill results. Every card includes an `id` field for frontend rendering.
 *
 * Replaces the narrow `buildStreamingRichCards()` in ToolDecisionEngine.
 */

import type { RichCardType, RichCardOutput, RichTextValue } from "@sunpilot/protocol";

export interface RichCardInput {
  type: RichCardType;
  name: string;
  url?: string;
  /** For structured results (products, search results, etc.) */
  data?: Record<string, unknown>;
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
          images: images.map((img, i) => ({
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
    title?: RichTextValue;
    subtitle?: RichTextValue;
    columns: Array<{
      key: string;
      label: RichTextValue;
      type?: "text" | "number" | "link" | "markdown" | "badge" | "image" | "actions";
      width?: number;
      sortable?: boolean;
    }>;
    rows: Array<Record<string, unknown>>;
    pagination?: false | { pageSize?: number };
  }): this {
    this.cards.push({
      id: `card_table_${this.cards.length}`,
      type: "table",
      title: input.title,
      subtitle: input.subtitle,
      data: {
        columns: input.columns,
        rows: input.rows,
        pagination: input.pagination,
      },
    });
    return this;
  }

  /**
   * Build a tool_result card
   */
  fromToolResult(input: {
    title?: RichTextValue;
    toolName: string;
    status: "running" | "completed" | "failed" | "pending";
    toolCallId?: string;
    summary?: string;
    detail?: string;
    artifacts?: string[];
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
        artifacts: input.artifacts,
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
    title?: RichTextValue;
    skillName: string;
    status: "running" | "completed" | "failed" | "pending";
    skillId?: string;
    steps?: Array<{
      title: string;
      description?: string;
      status: "done" | "active" | "pending" | "error";
    }>;
    stepCount?: number;
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
        stepCount: input.stepCount ?? input.steps?.length,
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
    title?: RichTextValue;
    url: string;
    description?: string;
    image?: string;
    domain?: string;
    favicon?: string;
  }): this {
    this.cards.push({
      id: `card_link_preview_${this.cards.length}`,
      type: "link_preview",
      title: input.title,
      data: {
        url: input.url,
        title: input.title,
        description: input.description,
        image: input.image,
        domain: input.domain,
        favicon: input.favicon,
      },
    });
    return this;
  }

  /**
   * Build a metric card
   */
  fromMetric(input: {
    title?: RichTextValue;
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
        metrics: [{
          label: input.label,
          value: input.value,
          change: input.change,
          tone: input.trend === "up" ? "green" : input.trend === "down" ? "pink" : "blue",
        }],
      },
    });
    return this;
  }

  /**
   * Build a checklist card
   */
  fromChecklist(input: {
    title?: RichTextValue;
    items: Array<{
      id: string;
      label: RichTextValue;
      description?: RichTextValue;
      checked?: boolean;
      required?: boolean;
      disabled?: boolean;
      evidence?: RichTextValue;
    }>;
    mode?: "local" | "submit";
    submitLabel?: string;
    requireAll?: boolean;
    confirmationText?: RichTextValue;
  }): this {
    this.cards.push({
      id: `card_checklist_${this.cards.length}`,
      type: "checklist",
      title: input.title,
      data: {
        items: input.items,
        mode: input.mode ?? "local",
        submitLabel: input.submitLabel,
        requireAll: input.requireAll,
        confirmationText: input.confirmationText,
      },
    });
    return this;
  }

  /**
   * Build a bar_chart card
   */
  fromBarChart(input: {
    title?: RichTextValue;
    items: Array<{ label: string; value: number; color?: string; group?: string }>;
    unit?: string;
    stacked?: boolean;
    horizontal?: boolean;
  }): this {
    this.cards.push({
      id: `card_bar_chart_${this.cards.length}`,
      type: "bar_chart",
      title: input.title,
      data: {
        items: input.items,
        unit: input.unit,
        stacked: input.stacked,
        horizontal: input.horizontal,
      },
    });
    return this;
  }

  /**
   * Build a pie_chart card
   */
  fromPieChart(input: {
    title?: RichTextValue;
    items: Array<{ label: string; value: number; color?: string }>;
    totalLabel?: string;
  }): this {
    this.cards.push({
      id: `card_pie_chart_${this.cards.length}`,
      type: "pie_chart",
      title: input.title,
      data: {
        items: input.items,
        totalLabel: input.totalLabel,
      },
    });
    return this;
  }

  /**
   * Build a line_chart card
   */
  fromLineChart(input: {
    title?: RichTextValue;
    series: Array<{ name: string; data: number[]; color?: string }>;
    xAxis: string[];
    yAxis?: { label?: string; unit?: string };
  }): this {
    this.cards.push({
      id: `card_line_chart_${this.cards.length}`,
      type: "line_chart",
      title: input.title,
      data: {
        series: input.series,
        xAxis: input.xAxis,
        yAxis: input.yAxis,
      },
    });
    return this;
  }

  /**
   * Build an audio card
   */
  fromAudio(input: {
    title?: RichTextValue;
    src: string;
    duration?: number;
    transcript?: string;
  }): this {
    this.cards.push({
      id: `card_audio_${this.cards.length}`,
      type: "audio",
      title: input.title,
      data: {
        src: input.src,
        duration: input.duration,
        transcript: input.transcript,
      },
    });
    return this;
  }

  /**
   * Build a file_bundle card
   */
  fromFileBundle(input: {
    title?: RichTextValue;
    files: Array<{
      name: string;
      size?: string;
      href?: string;
      type?: string;
    }>;
  }): this {
    this.cards.push({
      id: `card_file_bundle_${this.cards.length}`,
      type: "file_bundle",
      title: input.title,
      data: {
        files: input.files,
      },
    });
    return this;
  }

  /**
   * Build a record_card
   */
  fromRecord(input: {
    title?: RichTextValue;
    fields: Array<{
      key: string;
      label: string;
      value: string;
      type?: "text" | "link" | "code" | "badge";
    }>;
  }): this {
    this.cards.push({
      id: `card_record_${this.cards.length}`,
      type: "record_card",
      title: input.title,
      data: {
        fields: input.fields,
        title: input.title,
      },
    });
    return this;
  }

  /**
   * Build a json_viewer card
   */
  fromJsonViewer(input: {
    title?: RichTextValue;
    value: unknown;
    collapsedDepth?: number;
    rootName?: string;
  }): this {
    this.cards.push({
      id: `card_json_viewer_${this.cards.length}`,
      type: "json_viewer",
      title: input.title,
      data: {
        value: input.value,
        collapsedDepth: input.collapsedDepth,
        rootName: input.rootName,
      },
    });
    return this;
  }

  /**
   * Build a code_diff card
   */
  fromCodeDiff(input: {
    title?: RichTextValue;
    language?: string;
    diff: string;
    fileName?: string;
  }): this {
    this.cards.push({
      id: `card_code_diff_${this.cards.length}`,
      type: "code_diff",
      title: input.title,
      data: {
        language: input.language,
        diff: input.diff,
        fileName: input.fileName,
      },
    });
    return this;
  }

  /**
   * Build a comparison_table card
   */
  fromComparisonTable(input: {
    title?: RichTextValue;
    subjects: Array<{ name: string; description?: string }>;
    criteria: Array<{ key: string; label: string }>;
    values: Array<Array<string | number | boolean | null>>;
  }): this {
    this.cards.push({
      id: `card_comparison_table_${this.cards.length}`,
      type: "comparison_table",
      title: input.title,
      data: {
        subjects: input.subjects,
        criteria: input.criteria,
        values: input.values,
      },
    });
    return this;
  }

  /**
   * Build an area_chart card
   */
  fromAreaChart(input: {
    title?: RichTextValue;
    series: Array<{ name: string; data: number[]; color?: string }>;
    xAxis: string[];
    yAxis?: { label?: string; unit?: string };
  }): this {
    this.cards.push({
      id: `card_area_chart_${this.cards.length}`,
      type: "area_chart",
      title: input.title,
      data: {
        series: input.series,
        xAxis: input.xAxis,
        yAxis: input.yAxis,
      },
    });
    return this;
  }

  /**
   * Build a scatter_chart card
   */
  fromScatterChart(input: {
    title?: RichTextValue;
    points: Array<{ x: number; y: number; label?: string; size?: number; color?: string }>;
    xKey?: string;
    yKey?: string;
  }): this {
    this.cards.push({
      id: `card_scatter_chart_${this.cards.length}`,
      type: "scatter_chart",
      title: input.title,
      data: {
        points: input.points,
        xKey: input.xKey,
        yKey: input.yKey,
      },
    });
    return this;
  }

  /**
   * Build a radar_chart card
   */
  fromRadarChart(input: {
    title?: RichTextValue;
    axes: Array<{ label: string; max: number }>;
    series: Array<{ name: string; values: number[]; color?: string }>;
  }): this {
    this.cards.push({
      id: `card_radar_chart_${this.cards.length}`,
      type: "radar_chart",
      title: input.title,
      data: {
        axes: input.axes,
        series: input.series,
      },
    });
    return this;
  }

  /**
   * Build a heatmap card
   */
  fromHeatmap(input: {
    title?: RichTextValue;
    rows: string[];
    columns: string[];
    cells: Array<{ row: number; col: number; value: number; label?: string }>;
  }): this {
    this.cards.push({
      id: `card_heatmap_${this.cards.length}`,
      type: "heatmap",
      title: input.title,
      data: {
        rows: input.rows,
        columns: input.columns,
        cells: input.cells,
      },
    });
    return this;
  }

  /**
   * Build a stat_grid card
   */
  fromStatGrid(input: {
    title?: RichTextValue;
    metrics: Array<{
      label: string;
      value: string | number;
      change?: string;
      tone?: "blue" | "green" | "yellow" | "pink";
      description?: string;
    }>;
  }): this {
    this.cards.push({
      id: `card_stat_grid_${this.cards.length}`,
      type: "stat_grid",
      title: input.title,
      data: { metrics: input.metrics },
    });
    return this;
  }

  /**
   * Build a kpi_card
   */
  fromKpi(input: {
    title?: RichTextValue;
    label: string;
    value: string | number;
    trend?: "up" | "down" | "flat";
    change?: string;
    source?: string;
  }): this {
    this.cards.push({
      id: `card_kpi_${this.cards.length}`,
      type: "kpi_card",
      title: input.title,
      data: {
        label: input.label,
        value: input.value,
        trend: input.trend,
        change: input.change,
        source: input.source,
      },
    });
    return this;
  }

  /**
   * Build an approval_summary card
   */
  fromApprovalSummary(input: {
    title?: RichTextValue;
    items: Array<{
      id: string;
      title: string;
      description?: string;
      riskLevel?: "low" | "medium" | "high";
      status?: "pending" | "approved" | "rejected";
    }>;
    riskLevel?: "low" | "medium" | "high";
  }): this {
    this.cards.push({
      id: `card_approval_summary_${this.cards.length}`,
      type: "approval_summary",
      title: input.title,
      data: {
        items: input.items,
        riskLevel: input.riskLevel,
      },
    });
    return this;
  }

  /**
   * Build an action_list card
   */
  fromActionList(input: {
    title?: RichTextValue;
    items: Array<{
      id: string;
      title: string;
      description?: string;
      action?: { label: string; type: string; payload?: Record<string, unknown> };
      completed?: boolean;
    }>;
  }): this {
    this.cards.push({
      id: `card_action_list_${this.cards.length}`,
      type: "action_list",
      title: input.title,
      data: { items: input.items },
    });
    return this;
  }

  /**
   * Build a ranked_list card
   */
  fromRankedList(input: {
    title?: RichTextValue;
    items: Array<{
      title: string;
      score?: number | string;
      description?: string;
      badge?: string;
    }>;
  }): this {
    this.cards.push({
      id: `card_ranked_list_${this.cards.length}`,
      type: "ranked_list",
      title: input.title,
      data: { items: input.items },
    });
    return this;
  }

  /**
   * Build a steps card
   */
  fromSteps(input: {
    title?: RichTextValue;
    steps: Array<{
      title: string;
      description?: string;
      status: "done" | "active" | "pending" | "error";
    }>;
  }): this {
    this.cards.push({
      id: `card_steps_${this.cards.length}`,
      type: "steps",
      title: input.title,
      data: { steps: input.steps },
    });
    return this;
  }

  /**
   * Build a kanban card
   */
  fromKanban(input: {
    title?: RichTextValue;
    columns: Array<{ id: string; label: string }>;
    cards: Array<{
      id: string;
      title: string;
      columnId: string;
      description?: string;
      badge?: string;
    }>;
  }): this {
    this.cards.push({
      id: `card_kanban_${this.cards.length}`,
      type: "kanban",
      title: input.title,
      data: { columns: input.columns, cards: input.cards },
    });
    return this;
  }

  /**
   * Build a choice_group card
   */
  fromChoiceGroup(input: {
    title?: RichTextValue;
    options: Array<{ id: string; label: string; description?: string }>;
    mode: "single" | "multiple";
    selectedIds?: string[];
  }): this {
    this.cards.push({
      id: `card_choice_group_${this.cards.length}`,
      type: "choice_group",
      title: input.title,
      data: {
        options: input.options,
        mode: input.mode,
        selectedIds: input.selectedIds,
      },
    });
    return this;
  }

  /**
   * Build a form_card
   */
  fromForm(input: {
    title?: RichTextValue;
    fields: Array<{
      id: string;
      label: string;
      type: "text" | "textarea" | "number" | "select" | "email";
      placeholder?: string;
      required?: boolean;
      options?: Array<{ label: string; value: string }>;
    }>;
    submitLabel?: string;
  }): this {
    this.cards.push({
      id: `card_form_${this.cards.length}`,
      type: "form_card",
      title: input.title,
      data: { fields: input.fields, submitLabel: input.submitLabel },
    });
    return this;
  }

  /**
   * Build a rating_card
   */
  fromRating(input: {
    title?: RichTextValue;
    scale: number;
    labels?: string[];
    value?: number;
  }): this {
    this.cards.push({
      id: `card_rating_${this.cards.length}`,
      type: "rating_card",
      title: input.title,
      data: {
        scale: input.scale,
        labels: input.labels,
        value: input.value,
      },
    });
    return this;
  }

  /**
   * Build a date_picker_card
   */
  fromDatePicker(input: {
    title?: RichTextValue;
    mode: "date" | "time" | "datetime";
    min?: string;
    max?: string;
    value?: string;
  }): this {
    this.cards.push({
      id: `card_date_picker_${this.cards.length}`,
      type: "date_picker_card",
      title: input.title,
      data: {
        mode: input.mode,
        min: input.min,
        max: input.max,
        value: input.value,
      },
    });
    return this;
  }

  /**
   * Build a quote_card
   */
  fromQuote(input: {
    title?: RichTextValue;
    quote: string;
    source?: string;
    url?: string;
  }): this {
    this.cards.push({
      id: `card_quote_${this.cards.length}`,
      type: "quote_card",
      title: input.title,
      data: {
        quote: input.quote,
        source: input.source,
        url: input.url,
      },
    });
    return this;
  }

  /**
   * Build a citation_list card
   */
  fromCitationList(input: {
    title?: RichTextValue;
    items: Array<{
      title: string;
      url?: string;
      snippet?: string;
    }>;
  }): this {
    this.cards.push({
      id: `card_citation_list_${this.cards.length}`,
      type: "citation_list",
      title: input.title,
      data: { items: input.items },
    });
    return this;
  }

  /**
   * Build a definition_list card
   */
  fromDefinitionList(input: {
    title?: RichTextValue;
    items: Array<{ term: string; description: string }>;
  }): this {
    this.cards.push({
      id: `card_definition_list_${this.cards.length}`,
      type: "definition_list",
      title: input.title,
      data: { items: input.items },
    });
    return this;
  }

  /**
   * Build a rich_text card
   */
  fromRichText(input: {
    title?: RichTextValue;
    content: string;
    format?: "plain" | "markdown" | "auto";
  }): this {
    this.cards.push({
      id: `card_rich_text_${this.cards.length}`,
      type: "rich_text",
      title: input.title,
      data: { content: input.content, format: input.format },
    });
    return this;
  }

  /**
   * Build a product_grid card
   */
  fromProductGrid(input: {
    title?: RichTextValue;
    items: Array<{
      title: string;
      image?: string;
      price?: string;
      url?: string;
      description?: string;
      badge?: string;
    }>;
  }): this {
    this.cards.push({
      id: `card_product_grid_${this.cards.length}`,
      type: "product_grid",
      title: input.title,
      data: { items: input.items },
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
