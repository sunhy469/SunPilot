import type { AgentEventBus } from "./agent-event-bus.js";
import type {
  AssistantMessagePart,
  AssistantTextPart,
  AssistantStatusPart,
  AssistantToolUsePart,
  AssistantToolResultPart,
  AssistantErrorPart,
  IAssistantMessageStream,
  SaveMessageFn,
} from "./loop-types.js";

/**
 * AssistantMessageStream — 运行时对象，管理 assistant message 的内容块。
 *
 * 职责：
 * - 维护 parts 数组
 * - 发 agent.message.part.* 事件
 * - 合并 text parts 得到 content
 * - 完成时保存 message
 *
 * 不承担 tool execution、permission、planning 等业务逻辑。
 *
 * §Phase 2 of agent_interleaved_streaming_response_design.md
 */
export class AssistantMessageStream implements IAssistantMessageStream {
  private readonly parts: AssistantMessagePart[] = [];
  private started = false;
  private completed = false;
  private richCards: Array<{ type: string; title?: string; data: Record<string, unknown> }> = [];
  private deltaIndexByPartId = new Map<string, number>();

  constructor(
    private readonly params: {
      runId: string;
      conversationId: string;
      messageId: string;
      eventBus: AgentEventBus;
      saveMessage: SaveMessageFn;
      /** §Step 1a: Pre-populate parts for resume/hydrate (e.g. after approval).
       *  These parts are NOT re-emitted — they already exist in persisted state. */
      initialParts?: AssistantMessagePart[];
      /**
       * When true, skip emitting agent.message.started + agent.response.started
       * in start(). Use this when the caller has already emitted the events
       * (e.g. AgentLoopEngine.run() emits them early for immediate message card).
       */
      skipStartedEvents?: boolean;
    },
  ) {
    if (params.initialParts && params.initialParts.length > 0) {
      this.parts.push(...params.initialParts);
    }
  }

  get runId(): string {
    return this.params.runId;
  }

  get conversationId(): string {
    return this.params.conversationId;
  }

  get messageId(): string {
    return this.params.messageId;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Emit agent.message.started and mark the stream as active. */
  start(): void {
    if (this.started) return;
    this.started = true;

    if (!this.params.skipStartedEvents) {
      this.params.eventBus.emit(
        "agent.message.started",
        {
          runId: this.params.runId,
          conversationId: this.params.conversationId,
          messageId: this.params.messageId,
        },
        {
          runId: this.params.runId,
          conversationId: this.params.conversationId,
        },
      );
    }
  }

  // ── Text parts ─────────────────────────────────────────────────────

  /** Start a new text part. Returns the created part. */
  startTextPart(): AssistantTextPart {
    this.ensureStarted();
    const part: AssistantTextPart = {
      id: `part_text_${crypto.randomUUID()}`,
      type: "text",
      content: "",
      source: "model",
      status: "streaming",
      createdAt: new Date().toISOString(),
    };
    this.parts.push(part);

    this.params.eventBus.emit(
      "agent.message.part.started",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        part: {
          id: part.id,
          type: "text",
          content: "",
          status: "streaming",
          source: "model",
          createdAt: part.createdAt,
        },
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );

    return part;
  }

  /** Append delta text to a text part. Emits delta events. */
  appendText(partId: string, delta: string): void {
    const part = this.findPart<AssistantTextPart>(partId, "text");
    if (!part || part.status !== "streaming") return;

    part.content += delta;

    const deltaIndex = (this.deltaIndexByPartId.get(partId) ?? -1) + 1;
    this.deltaIndexByPartId.set(partId, deltaIndex);

    this.params.eventBus.emit(
      "agent.message.part.delta",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        partId,
        delta,
        deltaIndex,
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );

  }

  /** Mark a text part as completed. */
  completeTextPart(partId: string): void {
    const part = this.findPart<AssistantTextPart>(partId, "text");
    if (!part) return;

    part.status = "completed";
    part.completedAt = new Date().toISOString();

    this.params.eventBus.emit(
      "agent.message.part.updated",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        partId,
        patch: {
          status: "completed",
          completedAt: part.completedAt,
        },
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );
  }

  // ── Status parts ───────────────────────────────────────────────────

  /** Start a status part (e.g. "正在调用工具: search"). Returns the created part. */
  startStatus(input: {
    label: string;
    toolCallId?: string;
    metadata?: AssistantStatusPart["metadata"];
  }): AssistantStatusPart {
    this.ensureStarted();
    const part: AssistantStatusPart = {
      id: `part_status_${crypto.randomUUID()}`,
      type: "status",
      label: input.label,
      status: "running",
      toolCallId: input.toolCallId,
      runId: this.params.runId,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    };
    this.parts.push(part);

    this.params.eventBus.emit(
      "agent.message.part.started",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        part: {
          id: part.id,
          type: "status",
          label: part.label,
          status: "running",
          toolCallId: part.toolCallId,
          runId: part.runId,
          createdAt: part.createdAt,
          metadata: part.metadata,
        },
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );

    return part;
  }

  /** Update a tool_use part's status (§P1-3). */
  updateToolUse(
    toolCallId: string,
    patch: Pick<Partial<AssistantToolUsePart>, "status">,
  ): void {
    const part = this.parts.find(
      (p) => p.type === "tool_use" && p.toolCallId === toolCallId,
    ) as AssistantToolUsePart | undefined;
    if (!part) return;

    if (patch.status !== undefined) {
      part.status = patch.status;
    }

    this.params.eventBus.emit(
      "agent.message.part.updated",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        partId: part.id,
        patch: { status: part.status },
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );
  }

  /** Update a status part (e.g. label change, progress, completion). */
  updateStatus(
    partId: string,
    patch: Partial<
      Pick<AssistantStatusPart, "label" | "status"> & {
        completedAt: string;
        metadata: AssistantStatusPart["metadata"];
      }
    >,
  ): void {
    const part = this.findPart<AssistantStatusPart>(partId, "status");
    if (!part) return;

    if (patch.label !== undefined) part.label = patch.label;
    if (patch.status !== undefined) {
      part.status = patch.status;
      if (patch.status !== "running") {
        part.completedAt = patch.completedAt ?? new Date().toISOString();
      }
    }
    if (patch.metadata !== undefined) {
      part.metadata = { ...part.metadata, ...patch.metadata };
    }

    this.params.eventBus.emit(
      "agent.message.part.updated",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        partId,
        patch: {
          status: part.status,
          label: part.label,
          completedAt: part.completedAt,
          metadata: part.metadata,
        },
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );
  }

  // ── Tool use / result parts ────────────────────────────────────────

  /** Add a tool_use part (the LLM decided to call a tool). */
  addToolUse(input: {
    toolCallId: string;
    skillId: string;
    name: string;
    inputPreview?: Record<string, unknown>;
  }): AssistantToolUsePart {
    this.ensureStarted();
    const part: AssistantToolUsePart = {
      id: `part_tool_use_${crypto.randomUUID()}`,
      type: "tool_use",
      toolCallId: input.toolCallId,
      skillId: input.skillId,
      name: input.name,
      inputPreview: input.inputPreview,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.parts.push(part);

    this.params.eventBus.emit(
      "agent.message.part.started",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        part: {
          id: part.id,
          type: "tool_use",
          toolCallId: part.toolCallId,
          skillId: part.skillId,
          name: part.name,
          inputPreview: part.inputPreview,
          status: part.status,
          createdAt: part.createdAt,
        },
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );

    return part;
  }

  /** Add a tool_result part (result of executed tool). */
  addToolResult(input: {
    toolCallId: string;
    skillId: string;
    summary: string;
    artifactIds?: string[];
    trust?: "trusted" | "untrusted";
  }): AssistantToolResultPart {
    this.ensureStarted();
    const part: AssistantToolResultPart = {
      id: `part_tool_result_${crypto.randomUUID()}`,
      type: "tool_result",
      toolCallId: input.toolCallId,
      skillId: input.skillId,
      summary: input.summary,
      artifactIds: input.artifactIds,
      trust: input.trust ?? "trusted",
      visible: "collapsed",
      createdAt: new Date().toISOString(),
    };
    this.parts.push(part);

    this.params.eventBus.emit(
      "agent.message.part.started",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        part: {
          id: part.id,
          type: "tool_result",
          toolCallId: part.toolCallId,
          skillId: part.skillId,
          summary: part.summary,
          trust: part.trust,
          visible: part.visible,
          createdAt: part.createdAt,
        },
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );

    return part;
  }

  /**
   * §Step 1b: Return a deep copy of the current parts array.
   * Used to snapshot parts for approval resume / interrupt recovery.
   * Does NOT complete the stream.
   */
  getPartsSnapshot(): AssistantMessagePart[] {
    return this.parts.map((p) => ({ ...p } as AssistantMessagePart));
  }

  /**
   * Set rich cards for inline rendering (image/video artifacts).
   * These are persisted in message metadata and emitted in
   * agent.message.completed so the frontend can show artifact cards.
   */
  setRichCards(cards: Array<{ type: string; title?: string; data: Record<string, unknown> }>): void {
    this.richCards = cards;
  }

  // ── Error parts ────────────────────────────────────────────────────

  /** Add an error part. */
  addError(input: {
    message: string;
    code?: string;
    recoverable?: boolean;
  }): AssistantErrorPart {
    this.ensureStarted();
    const part: AssistantErrorPart = {
      id: `part_error_${crypto.randomUUID()}`,
      type: "error",
      message: input.message,
      code: input.code,
      recoverable: input.recoverable,
      createdAt: new Date().toISOString(),
    };
    this.parts.push(part);

    this.params.eventBus.emit(
      "agent.message.part.started",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        part: {
          id: part.id,
          type: "error",
          message: part.message,
          code: part.code,
          recoverable: part.recoverable,
          createdAt: part.createdAt,
        },
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );

    return part;
  }

  // ── Completion ─────────────────────────────────────────────────────

  /**
   * Complete the stream: merge text parts → content, save message,
   * emit agent.message.completed.
   */
  async complete(): Promise<{
    messageId: string;
    content: string;
    parts: AssistantMessagePart[];
  }> {
    if (this.completed) {
      // Already completed — return current state
      return {
        messageId: this.params.messageId,
        content: this.mergeContent(),
        parts: [...this.parts],
      };
    }
    this.completed = true;
    this.ensureStarted();

    const content = this.mergeContent();
    const toolCallIds = this.collectIds("tool_use", "toolCallId");
    const artifactIds = this.collectIds("tool_result", "artifactIds");

    // Save message with parts + rich cards in metadata
    try {
      await this.params.saveMessage({
        id: this.params.messageId,
        conversationId: this.params.conversationId,
        role: "assistant",
        content,
        runId: this.params.runId,
        metadata: {
          parts: this.parts.map((p) => ({ ...p })),
          toolCallIds,
          artifactIds,
          richCards: this.richCards.length > 0 ? this.richCards : undefined,
        },
      });
    } catch (err) {
      // Best effort — don't fail the run if save fails
      console.error(
        "[AssistantMessageStream] Failed to save message:",
        (err as Error).message,
      );
    }

    // Emit completion with rich cards for frontend inline rendering
    this.params.eventBus.emit(
      "agent.message.completed",
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
        messageId: this.params.messageId,
        content,
        parts: this.parts.map((p) => ({ ...p } as unknown as Record<string, unknown>)),
        cards: this.richCards.length > 0 ? this.richCards : undefined,
      },
      {
        runId: this.params.runId,
        conversationId: this.params.conversationId,
      },
    );

    return { messageId: this.params.messageId, content, parts: [...this.parts] };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private ensureStarted(): void {
    if (!this.started) {
      this.start();
    }
  }

  private findPart<T extends AssistantMessagePart>(
    partId: string,
    type: AssistantMessagePart["type"],
  ): T | undefined {
    return this.parts.find(
      (p) => p.id === partId && p.type === type,
    ) as T | undefined;
  }

  /** Check if any text part has non-empty content */
  hasTextContent(): boolean {
    return this.parts.some((p) => p.type === "text" && (p as AssistantTextPart).content.length > 0);
  }

  /** Merge all text parts into a single content string. */
  private mergeContent(): string {
    return this.parts
      .filter((p): p is AssistantTextPart => p.type === "text")
      .map((p) => p.content)
      .join("\n");
  }

  /** Collect unique IDs from parts of a given type. */
  private collectIds(
    partType: AssistantMessagePart["type"],
    field: string,
  ): string[] {
    const ids = new Set<string>();
    for (const part of this.parts) {
      if (part.type !== partType) continue;
      if (field === "artifactIds" && part.type === "tool_result") {
        for (const id of part.artifactIds ?? []) {
          ids.add(id);
        }
      } else {
        const val = (part as unknown as Record<string, unknown>)[field];
        if (typeof val === "string") ids.add(val);
      }
    }
    return Array.from(ids);
  }
}
