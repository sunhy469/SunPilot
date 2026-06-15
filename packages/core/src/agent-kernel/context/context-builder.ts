import type {
  AgentContext,
  AgentLoopInput,
  AttachmentRef,
  ContextBuilder as ContextBuilderInterface,
} from "../loop-types.js";
import { ContextChunk, estimateTokens } from "./context-types.js";
import { TokenBudgeter } from "./context-budgeter.js";

export interface ContextBuilderDeps {
  /** Fetch conversation messages for the given conversation. */
  listMessages: (
    conversationId: string,
    limit?: number,
  ) => Promise<
    Array<{
      id: string;
      role: string;
      content: string;
      attachments?: AttachmentRef[];
      createdAt: string;
    }>
  >;
  /** Fetch relevant memories with scope-aware isolation. */
  searchMemories?: (input: {
    query: string;
    runId: string;
    conversationId: string;
    userId?: string;
    limit?: number;
    /** Optional embedding vector for pure semantic (no-ILIKE) recall. */
    embedding?: number[];
  }) => Promise<
    Array<{
      id: string;
      type: string;
      title: string;
      content: string;
      source: string;
      confidence: number;
      scope?: string;
      scopeId?: string;
      score?: number;
      metadata?: Record<string, unknown>;
    }>
  >;
  /** List available skills. */
  listSkills?: () => Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      category: string;
    }>
  >;
  /** Fetch artifacts related to the current run. */
  listArtifacts?: (runId: string) => Promise<
    Array<{
      id: string;
      name: string;
      type: string;
      summary?: string;
    }>
  >;
  /** Fetch recent tool results related to the current run. */
  listToolResults?: (runId: string) => Promise<
    Array<{
      toolCallId: string;
      name?: string;
      skillId?: string;
      status: string;
      summary?: string;
      content?: string;
      structured?: Record<string, unknown>;
    }>
  >;
  /** System prompt personas and rules. */
  systemPrompt?: {
    persona?: string;
    rules?: string[];
  };
  /** Safety policy rules. */
  safetyRules?: string[];
  /** Maximum tokens for the context window. */
  maxContextTokens?: number;
  /** Reserved tokens for model output. */
  reservedOutputTokens?: number;
  /** Generate an embedding vector for the given text (best-effort). */
  embedText?: (text: string) => Promise<number[]>;
}

/**
 * ContextBuilder — 统一的上下文组装管线。
 *
 * 从多个数据源收集上下文（消息、记忆、技能、制品、工具结果、运行状态、安全策略），
 * 按优先级打包为 ContextChunk，应用 Token 预算（优先级低的 chunk 可能被裁剪），
 * 最终返回统一的 AgentContext。
 *
 * 上下文源及优先级（数字越大越容易被裁剪）：
 *   0  — system_prompt / safety_policy / current_message / run_state
 *   10 — conversation_history
 *   15 — memories（语义检索结果）
 *   18 — tool_results（最近工具调用结果）
 *   20 — skill_catalog（可用技能目录）
 *   25 — artifacts（运行中产生的制品）
 *
 * History is now token-budget-driven: we fetch up to MAX_HISTORY_MESSAGES
 * and let TokenBudgeter decide which to include based on available tokens.
 * Short conversations get full history; long ones get trimmed by priority.
 */
export class ContextBuilder implements ContextBuilderInterface {
  private readonly budgeter: TokenBudgeter;

  /** Maximum messages to fetch from history. TokenBudgeter may trim further. */
  private static readonly MAX_HISTORY_MESSAGES = 100;

  constructor(private readonly deps: ContextBuilderDeps) {
    this.budgeter = new TokenBudgeter(
      deps.maxContextTokens ?? 128_000,
      deps.reservedOutputTokens ?? 16_000,
    );
  }

  async build(
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<AgentContext> {
    const chunks: ContextChunk[] = [];
    let availableSkills: AgentContext["availableSkills"] = [];

    // ── System prompt ─────────────────────────────────────────────
    const persona =
      this.deps.systemPrompt?.persona ??
      "You are SunPilot, a concise and capable local agent assistant.";
    const rules = this.deps.systemPrompt?.rules ?? [
      "Always respond in the same language as the user.",
      "Use tools when they help complete the task more effectively.",
      "Cite memory sources when using remembered information.",
    ];
    const safety = this.deps.safetyRules ?? [
      "Never expose secrets, API keys, or passwords in responses.",
      "Never execute destructive commands without explicit user approval.",
      "Respect workspace boundaries; do not read or write files outside the project.",
    ];

    chunks.push({
      id: `system_persona`,
      source: "system",
      title: "Persona",
      content: persona,
      priority: 0,
      tokenEstimate: estimateTokens(persona),
      metadata: {},
    });

    const rulesContent = rules.map((r) => `- ${r}`).join("\n");
    chunks.push({
      id: `system_rules`,
      source: "system",
      title: "Rules",
      content: rulesContent,
      priority: 0,
      tokenEstimate: estimateTokens(rulesContent),
      metadata: {},
    });

    // ── Safety policy ─────────────────────────────────────────────
    const safetyContent = safety.map((s) => `- ${s}`).join("\n");
    chunks.push({
      id: `safety_policy`,
      source: "safety_policy",
      title: "Safety Policy",
      content: safetyContent,
      priority: 0,
      tokenEstimate: estimateTokens(safetyContent),
      metadata: {},
    });

    // ── Current message ───────────────────────────────────────────
    chunks.push({
      id: `current_message_${input.userMessageId}`,
      source: "current_message",
      title: "Current Message",
      content: input.message,
      priority: 0,
      tokenEstimate: estimateTokens(input.message),
      metadata: { messageId: input.userMessageId },
    });

    // ── Conversation history ──────────────────────────────────────
    // Tokens reserved before history insertion: track how much budget
    // is consumed so far so we can decide whether to compress early history.
    const preHistoryTokens = chunks.reduce(
      (sum, c) => sum + c.tokenEstimate,
      0,
    );

    try {
      const messages = await this.deps.listMessages(
        input.conversationId,
        ContextBuilder.MAX_HISTORY_MESSAGES,
      );

      // Check for existing conversation summaries to compress older history.
      // Summaries replace raw messages that fall within their range,
      // keeping only recent messages (after the latest summary's range)
      // as full text.
      let summaryChunks: ContextChunk[] = [];
      const summarizedMessageIds = new Set<string>();

      if (this.deps.searchMemories) {
        try {
          const summaryMemories = await this.deps.searchMemories({
            query: "conversation_summary",
            runId: input.runId,
            conversationId: input.conversationId,
            userId: input.userId,
            limit: 10,
          });
          const convSummaries = summaryMemories.filter(
            (m) => m.type === "conversation_summary",
          );

          // Collect all message IDs covered by any summary range.
          // Build a map: messageId → true for fast lookup.
          for (const summary of convSummaries) {
            const range = summary.metadata?.messageRange as
              | { fromMessageId?: string; toMessageId?: string }
              | undefined;
            if (range?.fromMessageId && range?.toMessageId) {
              // Find all messages between fromMessageId and toMessageId (inclusive)
              const fromIdx = messages.findIndex(
                (m) => m.id === range.fromMessageId,
              );
              const toIdx = messages.findIndex(
                (m) => m.id === range.toMessageId,
              );
              if (fromIdx >= 0 && toIdx >= fromIdx) {
                for (let i = fromIdx; i <= toIdx; i++) {
                  summarizedMessageIds.add(messages[i]!.id);
                }
              }
            }

            // ── Stale detection ────────────────────────────────────
            // A summary is stale when unconvered messages appear after
            // its range boundary. Stale summaries are still included but
            // at a lower priority since they may not reflect recent turns.
            let isStale = false;
            if (range?.toMessageId) {
              const boundaryIdx = messages.findIndex(
                (m) => m.id === range.toMessageId,
              );
              isStale =
                boundaryIdx >= 0 && boundaryIdx < messages.length - 1;
            }

            summaryChunks.push({
              id: `summary_${summary.id}`,
              source: "conversation_summary",
              title: summary.title
                + (isStale ? " [stale — new messages since]" : ""),
              content: `[Previous conversation summary${isStale ? " (may be outdated)" : ""}]\n${summary.content}`,
              // Stale summaries get lower priority (12) so they may be
              // trimmed if budget is tight, but still above raw history.
              priority: isStale ? 12 : 8,
              tokenEstimate: estimateTokens(summary.content),
              metadata: {
                memoryId: summary.id,
                type: "conversation_summary",
                confidence: summary.confidence,
                score: summary.score,
              },
            });
          }
        } catch {
          // Memory search unavailable — skip summaries
        }
      }

      // Build history chunks, skipping messages already covered by a summary.
      // This is precise compaction: summarized messages are replaced by their
      // summary, reducing token usage while preserving conversation context.
      let skippedCount = 0;
      for (const msg of messages) {
        if (msg.id === input.userMessageId) continue; // skip current
        if (summarizedMessageIds.has(msg.id)) {
          skippedCount++;
          continue; // covered by a conversation summary
        }
        chunks.push({
          id: `history_${msg.id}`,
          source: "conversation_history",
          title: `${msg.role} message`,
          content: msg.content,
          priority: 10,
          tokenEstimate: estimateTokens(msg.content),
          metadata: {
            messageId: msg.id,
            role: msg.role,
            attachments: msg.attachments,
          },
          createdAt: msg.createdAt,
        });
      }

      // Prepend summary chunks so they appear before raw history in the prompt.
      // Summaries have lower priority (8 < 10) so they survive token budget
      // cuts better than raw history.
      if (summaryChunks.length > 0) {
        chunks.push(...summaryChunks);
      }
    } catch {
      // Conversation store not available — skip history
    }

    // ── Memories ──────────────────────────────────────────────────
    if (this.deps.searchMemories) {
      try {
        // Generate query embedding once for reuse
        let queryEmbedding: number[] | undefined;
        if (this.deps.embedText && input.message.trim()) {
          try {
            queryEmbedding = await this.deps.embedText(input.message);
          } catch {
            // Embedding unavailable — hybrid search still works with keyword
          }
        }

        // Pass 1: Hybrid search (query + embedding) — keyword-dominant
        const hybridMemories = await this.deps.searchMemories({
          query: input.message,
          runId: input.runId,
          conversationId: input.conversationId,
          userId: input.userId,
          limit: 10,
          embedding: queryEmbedding,
        });

        // Pass 2: Pure vector recall (embedding only, empty query)
        // This triggers the semantic-only path in PostgresMemoryRepository
        // where ILIKE pre-filter is skipped. Effectively doubles recall
        // coverage by adding semantically-similar but lexically-different
        // memories that keyword search would miss.
        let vectorMemories: Awaited<ReturnType<typeof this.deps.searchMemories>> = [];
        if (queryEmbedding) {
          try {
            vectorMemories = await this.deps.searchMemories({
              query: "",
              runId: input.runId,
              conversationId: input.conversationId,
              userId: input.userId,
              limit: 5,
              embedding: queryEmbedding,
            });
          } catch {
            // Pure vector recall unavailable — use hybrid results only
          }
        }

        // Merge: deduplicate by id, preferring hybrid (higher relevance) score
        const seenIds = new Set<string>();
        const allMemories = [...hybridMemories];
        for (const mem of vectorMemories) {
          if (!seenIds.has(mem.id)) {
            seenIds.add(mem.id);
            allMemories.push(mem);
          }
        }

        // Sort by score descending
        allMemories.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

        for (const mem of allMemories.slice(0, 15)) {
          const content = `[${mem.type}] ${mem.title}: ${mem.content}`;
          chunks.push({
            id: `memory_${mem.id}`,
            source: "memory",
            title: mem.title,
            content,
            priority: 15,
            tokenEstimate: estimateTokens(content),
            metadata: {
              memoryId: mem.id,
              type: mem.type,
              source: mem.source,
              confidence: mem.confidence,
              scope: mem.scope,
              scopeId: mem.scopeId,
              score: mem.score,
            },
          });
        }
      } catch {
        // Memory store not available
      }
    }

    // ── Artifacts ─────────────────────────────────────────────────
    if (this.deps.listArtifacts) {
      try {
        const artifacts = await this.deps.listArtifacts(input.runId);
        for (const artifact of artifacts) {
          const content = `${artifact.name}: ${artifact.summary ?? artifact.type}`;
          chunks.push({
            id: `artifact_${artifact.id}`,
            source: "artifact",
            title: artifact.name,
            content,
            priority: 25,
            tokenEstimate: estimateTokens(content),
            metadata: {
              artifactId: artifact.id,
              type: artifact.type,
              summary: artifact.summary,
            },
          });
        }
      } catch {
        // Artifact store not available
      }
    }

    // ── Tool results ──────────────────────────────────────────────
    if (this.deps.listToolResults) {
      try {
        const toolResults = await this.deps.listToolResults(input.runId);
        for (const result of toolResults) {
          const content =
            result.summary ??
            result.content ??
            `${result.name ?? result.skillId ?? result.toolCallId}: ${result.status}`;
          chunks.push({
            id: `tool_result_${result.toolCallId}`,
            source: "tool_result",
            title: result.name ?? result.skillId ?? result.toolCallId,
            content,
            priority: 18,
            tokenEstimate: estimateTokens(content),
            metadata: {
              toolCallId: result.toolCallId,
              status: result.status,
              content: result.content,
              structured: result.structured,
            },
          });
        }
      } catch {
        // Tool call store not available
      }
    }

    // ── Skill catalog summary ─────────────────────────────────────
    if (this.deps.listSkills) {
      try {
        const skills = await this.deps.listSkills();
        availableSkills = skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          category: skill.category,
        }));
        const skillSummaries = skills
          .map((s) => `- ${s.name} (${s.id}): ${s.description} [${s.category}]`)
          .join("\n");
        chunks.push({
          id: `skill_catalog`,
          source: "skill_catalog",
          title: "Available Skills",
          content:
            skillSummaries ||
            "No skills available. Respond as a conversational assistant.",
          priority: 20,
          tokenEstimate: estimateTokens(skillSummaries),
          metadata: { skillCount: skills.length },
        });
      } catch {
        availableSkills = [];
        chunks.push({
          id: `skill_catalog`,
          source: "skill_catalog",
          title: "Available Skills",
          content: "Skill catalog unavailable.",
          priority: 20,
          tokenEstimate: estimateTokens("Skill catalog unavailable."),
          metadata: {},
        });
      }
    }

    // ── Run state ─────────────────────────────────────────────────
    chunks.push({
      id: `run_state`,
      source: "run_state",
      title: "Run State",
      content: `Run ID: ${input.runId}\nConversation: ${input.conversationId}\nMode: ${input.mode}`,
      priority: 0,
      tokenEstimate: estimateTokens(
        `Run ID: ${input.runId}\nConversation: ${input.conversationId}\nMode: ${input.mode}`,
      ),
      metadata: { runId: input.runId },
    });

    // ── Apply token budget ────────────────────────────────────────
    const budget = this.budgeter.apply(chunks);

    // ── Build context snapshot for observability ──────────────────
    const contextSnapshot = {
      chunks: [
        ...budget.included.map((c) => ({
          id: c.id,
          source: c.source,
          priority: c.priority,
          tokenEstimate: c.tokenEstimate,
          included: true as const,
        })),
        ...budget.excluded.map((c) => ({
          id: c.id,
          source: c.source,
          priority: c.priority,
          tokenEstimate: c.tokenEstimate,
          included: false as const,
          reason: "token_budget" as const,
        })),
      ],
      totalTokens: budget.totalTokens,
      droppedCount: budget.excluded.length,
    };

    // ── Pack into AgentContext ────────────────────────────────────
    const systemChunks = budget.included.filter((c) => c.source === "system");
    const safetyChunks = budget.included.filter(
      (c) => c.source === "safety_policy",
    );

    return {
      runId: input.runId,
      conversationId: input.conversationId,
      userId: input.userId,
      system: {
        persona:
          systemChunks.find((c) => c.title === "Persona")?.content ?? persona,
        rules: rules,
        safety: safetyChunks.map((c) => c.content),
      },
      currentMessage: {
        id: input.userMessageId,
        content: input.message,
        attachments: input.attachments ?? [],
      },
      messages: [
        // Conversation summaries appear first as system-level context,
        // replacing older raw messages that have been compressed.
        ...budget.included
          .filter((c) => c.source === "conversation_summary")
          .map((c) => ({
            role: "system" as const,
            content: c.content,
            metadata: {
              memoryId: c.metadata.memoryId,
              type: "conversation_summary",
            },
          })),
        // Raw conversation history messages
        ...budget.included
          .filter((c) => c.source === "conversation_history")
          .map((c) => ({
            role: (c.metadata.role as "user" | "assistant" | "system") ?? "user",
            content: c.content,
            metadata: {
              messageId: c.metadata.messageId,
              attachments: c.metadata.attachments,
            },
          })),
      ],
      memories: budget.included
        .filter((c) => c.source === "memory")
        .map((c) => ({
          id: (c.metadata.memoryId as string) ?? c.id,
          type: (c.metadata.type as string) ?? "unknown",
          title: c.title,
          content: c.content,
          source: (c.metadata.source as string) ?? "memory",
          confidence: (c.metadata.confidence as number) ?? 0.5,
          scope: c.metadata.scope as string | undefined,
          scopeId: c.metadata.scopeId as string | undefined,
          score: c.metadata.score as number | undefined,
        })),
      artifacts: budget.included
        .filter((c) => c.source === "artifact")
        .map((c) => ({
          id: (c.metadata.artifactId as string) ?? c.id,
          name: c.title,
          type: (c.metadata.type as string) ?? "other",
          summary: (c.metadata.summary as string | undefined) ?? c.content,
        })),
      toolResults: budget.included
        .filter((c) => c.source === "tool_result")
        .map((c) => ({
          toolCallId: (c.metadata.toolCallId as string) ?? c.id,
          summary: c.content,
          content: c.metadata.content as string | undefined,
          status: (c.metadata.status as string) ?? "completed",
          structured: c.metadata.structured as Record<string, unknown> | undefined,
        })),
      availableSkills: budget.included.some((c) => c.source === "skill_catalog")
        ? availableSkills
        : [],
      limits: {
        maxTokens: this.deps.maxContextTokens ?? 128_000,
        reservedForOutput: this.deps.reservedOutputTokens ?? 16_000,
        usedTokensEstimate: budget.totalTokens,
      },
      tokenEstimate: budget.totalTokens,
      contextSnapshot,
    };
  }
}
