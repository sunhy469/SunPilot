import type {
  AgentContext,
  AgentLoopInput,
  AttachmentRef,
  ContextBuilder as ContextBuilderInterface,
} from "../loop-types.js";
import { ContextChunk, estimateTokens } from "./context-types.js";
import { TokenBudgeter } from "./context-budgeter.js";
import {
  SummaryStaleDetector,
  type StaleDetectionInput,
} from "./summary-stale-detector.js";

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
    /** Filter by memory types (e.g. ["conversation_summary"]). */
    types?: string[];
    /** Filter by scopes (e.g. ["conversation"]). */
    scopes?: string[];
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
  /** Summary stale detector — checks if conversation summaries need regeneration. */
  staleDetector?: SummaryStaleDetector;
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
  /** Enable timing debug logs. Controlled by SUNPILOT_DEBUG_CONTEXT_TIMING env. */
  private static readonly DEBUG_TIMING =
    typeof process !== "undefined" && process.env?.SUNPILOT_DEBUG_CONTEXT_TIMING === "1";

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
    const t0 = Date.now();
    // §P0-3: Phase timing for trace observability
    let groupAParallelMs = 0;
    let memorySearchMs = 0;
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
      trust: "system",
      authority: 10,
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
      trust: "system",
      authority: 10,
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
      trust: "system",
      authority: 10,
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
      trust: "user",
    });

    // External attachment warning is handled by ResponseComposer
    // (appendAttachmentLines adds [EXTERNAL — unverified source] prefix).
    // No separate chunk needed here — it would consume budget without
    // being mapped into the model input (pack section has no "external"
    // source mapping).
    // Tokens reserved before history insertion: track how much budget
    // is consumed so far so we can decide whether to compress early history.
    const preHistoryTokens = chunks.reduce(
      (sum, c) => sum + c.tokenEstimate,
      0,
    );

    try {
      // ── Parallel IO Group A: all independent data fetches ─────────
      // Launch all IO operations that have no inter-dependencies in parallel.
      // This reduces total latency from sum(all IO) to max(all IO).
      // Uses Promise.allSettled to distinguish normal empty results from
      // failures — critical dependencies log warnings on rejection.
      const tGroupA = Date.now();
      const [
        messagesSettled,
        summaryMemoriesSettled,
        queryEmbeddingSettled,
        artifactsSettled,
        toolResultsSettled,
        skillsSettled,
      ] = await Promise.allSettled([
        // 1. Conversation history
        this.deps.listMessages(
          input.conversationId,
          ContextBuilder.MAX_HISTORY_MESSAGES,
        ),
        // 2. Conversation summaries (type+scope filter, no ILIKE)
        this.deps.searchMemories
          ? this.deps.searchMemories({
              query: "",
              runId: input.runId,
              conversationId: input.conversationId,
              userId: input.userId,
              limit: 10,
              types: ["conversation_summary"],
              scopes: ["conversation"],
            })
          : Promise.resolve([] as Awaited<ReturnType<NonNullable<typeof this.deps.searchMemories>>>),
        // 3. Query embedding (needed for memory search in Group B)
        this.deps.embedText && input.message.trim()
          ? this.deps.embedText(input.message)
          : Promise.resolve(undefined as number[] | undefined),
        // 4. Artifacts
        this.deps.listArtifacts
          ? this.deps.listArtifacts(input.runId)
          : Promise.resolve([] as Awaited<ReturnType<NonNullable<typeof this.deps.listArtifacts>>>),
        // 5. Tool results (for main context, not stale detection)
        this.deps.listToolResults
          ? this.deps.listToolResults(input.runId)
          : Promise.resolve([] as Awaited<ReturnType<NonNullable<typeof this.deps.listToolResults>>>),
        // 6. Skill catalog
        this.deps.listSkills
          ? this.deps.listSkills()
          : Promise.resolve([] as Awaited<ReturnType<NonNullable<typeof this.deps.listSkills>>>),
      ]);

      // §P2: Unwrap settled results — log failures to console.error for
      // production visibility. Future: emit via event bus for trace integration.
      const messages = messagesSettled.status === "fulfilled"
        ? messagesSettled.value
        : (() => { console.error("[ContextBuilder] listMessages FAILED", { runId: input.runId, reason: String(messagesSettled.reason) }); return [] as Awaited<ReturnType<typeof this.deps.listMessages>>; })();
      const summaryMemoriesResult = summaryMemoriesSettled.status === "fulfilled"
        ? summaryMemoriesSettled.value
        : (() => { console.error("[ContextBuilder] searchMemories(summary) FAILED", { runId: input.runId, reason: String(summaryMemoriesSettled.reason) }); return [] as Awaited<ReturnType<NonNullable<typeof this.deps.searchMemories>>>; })();
      const queryEmbedding = queryEmbeddingSettled.status === "fulfilled"
        ? queryEmbeddingSettled.value
        : (() => { console.error("[ContextBuilder] embedText FAILED", { runId: input.runId, reason: String(queryEmbeddingSettled.reason) }); return undefined as number[] | undefined; })();
      const artifactsResult = artifactsSettled.status === "fulfilled"
        ? artifactsSettled.value
        : (() => { console.error("[ContextBuilder] listArtifacts FAILED", { runId: input.runId, reason: String(artifactsSettled.reason) }); return [] as Awaited<ReturnType<NonNullable<typeof this.deps.listArtifacts>>>; })();
      const toolResultsResult = toolResultsSettled.status === "fulfilled"
        ? toolResultsSettled.value
        : (() => { console.error("[ContextBuilder] listToolResults FAILED", { runId: input.runId, reason: String(toolResultsSettled.reason) }); return [] as Awaited<ReturnType<NonNullable<typeof this.deps.listToolResults>>>; })();
      const skillsResult = skillsSettled.status === "fulfilled"
        ? skillsSettled.value
        : (() => { console.error("[ContextBuilder] listSkills FAILED", { runId: input.runId, reason: String(skillsSettled.reason) }); return [] as Awaited<ReturnType<NonNullable<typeof this.deps.listSkills>>>; })();

      // §P0-3: Always capture timing for trace observability
      groupAParallelMs = Date.now() - tGroupA;
      if (ContextBuilder.DEBUG_TIMING) {
        console.debug(`[ContextBuilder] group_a_parallel_ms=${groupAParallelMs}`);
      }

      // ── Process summaries & stale detection (depends on messages + summaries) ──
      // Check for existing conversation summaries to compress older history.
      // Summaries replace raw messages that fall within their range,
      // keeping only recent messages (after the latest summary's range)
      // as full text.
      let summaryChunks: ContextChunk[] = [];
      const summarizedMessageIds = new Set<string>();

      if (this.deps.searchMemories && summaryMemoriesResult.length > 0) {
        const convSummaries = summaryMemoriesResult;

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

          // ── Stale detection (§P0 — full detector integration) ──
          // Phase 1: Range-based heuristic (fast path — always computed).
          // Phase 2: Semantic stale detection via SummaryStaleDetector
          //   (goal-change / correction / fact-change / preference-conflict).
          // Semantic detection wins when it reports higher severity.
          let isStale = false;
          let staleSeverity: "info" | "warning" | "critical" = "info";
          let staleReasons: string[] = [];

          // Phase 1 — range-based: new messages after summary boundary
          if (range?.toMessageId) {
            const boundaryIdx = messages.findIndex(
              (m) => m.id === range.toMessageId,
            );
            if (boundaryIdx >= 0 && boundaryIdx < messages.length - 1) {
              isStale = true;
              staleSeverity = "warning";
              staleReasons.push("New messages after summary boundary");
            }
          }

          // Phase 2 — semantic: full SummaryStaleDetector check
          if (this.deps.staleDetector) {
            try {
              // Collect messages after this summary's boundary.
              // CRITICAL: the current user message MUST be included —
              // it is the single most important signal for goal-change
              // and correction detection (e.g. "actually, use Vue instead").
              const boundaryIdx = range?.toMessageId
                ? messages.findIndex((m) => m.id === range.toMessageId)
                : -1;
              const messagesAfter = boundaryIdx >= 0
                ? messages.slice(boundaryIdx + 1)
                : [];
              // Always ensure the current user message is present for
              // stale detection, even when it's the only message after
              // the summary boundary.
              const hasCurrentInMessages = messagesAfter.some(
                (m) => m.id === input.userMessageId,
              );
              const detectorMessages = hasCurrentInMessages
                ? messagesAfter
                : [
                    ...messagesAfter,
                    {
                      id: input.userMessageId,
                      role: "user",
                      content: input.message,
                      createdAt: new Date().toISOString(),
                    },
                  ];

              // Collect recent tool results for fact-change detection
              // NOTE: We reuse toolResultsResult from Group A instead of
              // making a separate DB query here (was a duplicate query before).
              let newToolResults: StaleDetectionInput["newToolResults"];
              if (toolResultsResult.length > 0 && detectorMessages.length > 0) {
                newToolResults = toolResultsResult
                  .filter((tr) => tr.status === "completed")
                  .map((tr) => ({
                    skillId: tr.skillId ?? tr.name ?? tr.toolCallId,
                    summary: tr.summary ?? "",
                    status: tr.status,
                  }));
              }

              const semanticResult = this.deps.staleDetector.checkStale({
                summary: {
                  id: summary.id,
                  content: summary.content,
                  metadata: summary.metadata as Record<string, unknown> | undefined,
                  createdAt:
                    typeof summary.metadata?.createdAt === "string"
                      ? summary.metadata.createdAt
                      : new Date().toISOString(),
                },
                newMessages: detectorMessages.map((m) => ({
                  role: m.role,
                  content: m.content,
                })),
                newToolResults,
              });

              // Semantic detection wins when it reports higher severity
              if (semanticResult.stale) {
                isStale = true;
                // Upgrade severity if semantic detects a worse condition
                const severityRank = {
                  info: 0,
                  warning: 1,
                  critical: 2,
                } as const;
                if (
                  severityRank[semanticResult.severity] >
                  severityRank[staleSeverity]
                ) {
                  staleSeverity = semanticResult.severity;
                }
                staleReasons = [
                  ...staleReasons,
                  ...semanticResult.reasons,
                ];
              }
            } catch {
              // Stale detector failed — keep range-based result
            }
          }

          // severity → priority mapping:
          //   critical (goal-change / correction) → 14 (near trim line)
          //   warning  (fact-change / preference)  → 12
          //   info     (not stale)                  → 8  (keep above raw history)
          const stalePriorityMap: Record<string, number> = {
            critical: 14,
            warning: 12,
            info: 8,
          };
          const summaryPriority = isStale
            ? (stalePriorityMap[staleSeverity] ?? 8)
            : 8;
          const staleLabel = isStale
            ? ` [STALE ${staleSeverity.toUpperCase()}: ${staleReasons.join("; ")}]`
            : "";
          const staleContentPrefix = isStale
            ? `[Previous conversation summary — ${staleSeverity === "critical" ? "CRITICALLY OUTDATED" : "may be outdated"}${staleReasons.length > 0 ? ` (${staleReasons.join("; ")})` : ""}]\n`
            : "[Previous conversation summary]\n";

          summaryChunks.push({
            id: `summary_${summary.id}`,
            source: "conversation_summary",
            title: summary.title + staleLabel,
            content: staleContentPrefix + summary.content,
            priority: summaryPriority,
            tokenEstimate: estimateTokens(summary.content),
            metadata: {
              memoryId: summary.id,
              type: "conversation_summary",
              confidence: summary.confidence,
              score: summary.score ?? undefined,
            },
            trust: "user",
            warning: isStale
              ? `This summary is stale (${staleSeverity}). Reasons: ${staleReasons.join("; ")}`
              : undefined,
          });
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
          trust: msg.role === "assistant" ? "tool" : "user",
        });
      }

      // Prepend summary chunks so they appear before raw history in the prompt.
      // Summaries have lower priority (8 < 10) so they survive token budget
      // cuts better than raw history.
      if (summaryChunks.length > 0) {
        chunks.push(...summaryChunks);
      }

      if (ContextBuilder.DEBUG_TIMING) {
        console.debug(`[ContextBuilder] history_fetch_ms=${Date.now() - t0}`);
      }

      // ── Parallel IO Group B: memory search (depends on queryEmbedding) ──
      // §P1-3: Soft timeout — total memory search budget 500ms. Vector recall
      // runs in parallel with hybrid but is cut at 500ms instead of 2s.
      // Deep recall for complex tasks runs asynchronously after first response.
      const tMemory = Date.now();
      const MEMORY_BUDGET_MS = 500;
      if (this.deps.searchMemories) {
        try {
          // Pass 1: Hybrid search (query + embedding) — keyword-dominant
          // Pass 2: Pure vector recall (embedding only, empty query, 500ms cap)
          // Both can run in parallel since they only depend on queryEmbedding
          // from Group A.
          const [hybridMemories, vectorMemories] = await Promise.all([
            // Hybrid search with 500ms soft timeout
            Promise.race([
              this.deps.searchMemories({
                query: input.message,
                runId: input.runId,
                conversationId: input.conversationId,
                userId: input.userId,
                limit: 10,
                embedding: queryEmbedding,
              }),
              new Promise<Awaited<ReturnType<NonNullable<typeof this.deps.searchMemories>>>>((resolve) =>
                setTimeout(() => resolve([]), MEMORY_BUDGET_MS),
              ),
            ]).catch(() => [] as Awaited<ReturnType<NonNullable<typeof this.deps.searchMemories>>>),
            queryEmbedding
              ? Promise.race([
                  this.deps.searchMemories!({
                    query: "",
                    runId: input.runId,
                    conversationId: input.conversationId,
                    userId: input.userId,
                    limit: 5,
                    embedding: queryEmbedding,
                  }),
                  new Promise<Awaited<ReturnType<NonNullable<typeof this.deps.searchMemories>>>>((resolve) =>
                    setTimeout(() => resolve([]), MEMORY_BUDGET_MS),
                  ),
                ]).catch(() => [] as Awaited<ReturnType<NonNullable<typeof this.deps.searchMemories>>>)
              : Promise.resolve([] as Awaited<ReturnType<NonNullable<typeof this.deps.searchMemories>>>),
          ]);

          // Merge: deduplicate by id, preferring hybrid (higher relevance) score.
          // Pre-populate seenIds with hybrid results so vector recall can't
          // inject duplicates of the same memory.
          const seenIds = new Set(hybridMemories.map((m) => m.id));
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
              trust: "memory",
              sourceUri: `memory:${mem.id}`,
              generatedAt: new Date().toISOString(),
              // Memory chunks expire after 24h — they carry lower trust weight
              // once past their freshness window (see Gap-4: lifecycle fields).
              expiresAt: new Date(
                Date.now() + 24 * 60 * 60 * 1000,
              ).toISOString(),
            });
          }
        } catch {
          // Memory store not available
        }
      }
      // §P0-3: Always capture timing for trace observability
      memorySearchMs = Date.now() - tMemory;
      if (ContextBuilder.DEBUG_TIMING) {
        console.debug(`[ContextBuilder] memory_search_ms=${memorySearchMs}`);
      }

      // ── Artifacts (from Group A result) ───────────────────────────
      if (artifactsResult.length > 0) {
        for (const artifact of artifactsResult) {
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
            trust: "tool",
            generatedAt: new Date().toISOString(),
          });
        }
      }

      // ── Tool results (from Group A result) ────────────────────────
      if (toolResultsResult.length > 0) {
        for (const result of toolResultsResult) {
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
            trust: "tool",
            sourceUri: `tool_call:${result.toolCallId}`,
            generatedAt: new Date().toISOString(),
          });
        }
      }

      // ── Skill catalog (from Group A result) ───────────────────────
      const tSkills = Date.now();
      if (this.deps.listSkills) {
        const skillsFailed = skillsSettled.status === "rejected";
        if (skillsResult.length > 0) {
          availableSkills = skillsResult.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            category: skill.category,
          }));
          const skillSummaries = skillsResult
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
            metadata: { skillCount: skillsResult.length },
            trust: "system",
          });
        } else if (skillsFailed) {
          // listSkills query failed — system degradation, not "no skills"
          availableSkills = [];
          chunks.push({
            id: `skill_catalog`,
            source: "skill_catalog",
            title: "Available Skills",
            content: "Skill catalog unavailable due to a system error. Respond as a conversational assistant and inform the user that tools are temporarily unavailable.",
            priority: 20,
            tokenEstimate: estimateTokens("Skill catalog unavailable due to a system error."),
            metadata: { skillCount: 0, degraded: true },
            trust: "system",
          });
        } else {
          // listSkills succeeded but returned empty — no skills configured
          availableSkills = [];
          chunks.push({
            id: `skill_catalog`,
            source: "skill_catalog",
            title: "Available Skills",
            content: "No skills available. Respond as a conversational assistant.",
            priority: 20,
            tokenEstimate: estimateTokens("No skills available. Respond as a conversational assistant."),
            metadata: { skillCount: 0 },
            trust: "system",
          });
        }
      }
      if (ContextBuilder.DEBUG_TIMING) {
        console.debug(`[ContextBuilder] skill_catalog_ms=${Date.now() - tSkills}`);
      }
    } catch {
      // Parallel IO or context processing failed — skip context enrichment
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
      trust: "system",
    });

    // ── Apply token budget ────────────────────────────────────────

    // ── Per-source content compression (§P1) ──────────────────────
    // Before budget trimming, apply source-specific truncation so that
    // long chunks don't get dropped entirely. This preserves key info
    // while freeing tokens for other sources.
    const MAX_TOOL_RESULT_CHARS = 2000;
    const MAX_ARTIFACT_CHARS = 1000;
    const MAX_MEMORY_CHARS = 800;
    const MAX_HISTORY_MSG_CHARS = 4000;
    for (const chunk of chunks) {
      if (chunk.content.length <= 500) continue; // skip already-short chunks

      switch (chunk.source) {
        case "tool_result": {
          if (chunk.content.length > MAX_TOOL_RESULT_CHARS) {
            const originalLength = chunk.content.length;
            const truncated = chunk.content.slice(0, MAX_TOOL_RESULT_CHARS);
            chunk.content =
              truncated +
              `…[truncated ${originalLength - MAX_TOOL_RESULT_CHARS} chars]`;
            chunk.tokenEstimate = estimateTokens(chunk.content);
            chunk.metadata.truncated = true;
            chunk.metadata.originalLength = originalLength;
          }
          break;
        }
        case "artifact": {
          if (chunk.content.length > MAX_ARTIFACT_CHARS) {
            const originalLength = chunk.content.length;
            const truncated = chunk.content.slice(0, MAX_ARTIFACT_CHARS);
            chunk.content =
              truncated +
              `…[truncated ${originalLength - MAX_ARTIFACT_CHARS} chars]`;
            chunk.tokenEstimate = estimateTokens(chunk.content);
            chunk.metadata.truncated = true;
            chunk.metadata.originalLength = originalLength;
          }
          break;
        }
        case "memory": {
          if (chunk.content.length > MAX_MEMORY_CHARS) {
            const originalLength = chunk.content.length;
            const truncated = chunk.content.slice(0, MAX_MEMORY_CHARS);
            chunk.content =
              truncated +
              `…[truncated ${originalLength - MAX_MEMORY_CHARS} chars]`;
            chunk.tokenEstimate = estimateTokens(chunk.content);
            chunk.metadata.truncated = true;
            chunk.metadata.originalLength = originalLength;
          }
          break;
        }
        case "conversation_history": {
          if (chunk.content.length > MAX_HISTORY_MSG_CHARS) {
            const originalLength = chunk.content.length;
            const truncated = chunk.content.slice(0, MAX_HISTORY_MSG_CHARS);
            chunk.content =
              truncated +
              `…[truncated ${originalLength - MAX_HISTORY_MSG_CHARS} chars]`;
            chunk.tokenEstimate = estimateTokens(chunk.content);
            chunk.metadata.truncated = true;
            chunk.metadata.originalLength = originalLength;
          }
          break;
        }
        default:
          // system / safety / current_message / skill_catalog — never truncate
          break;
      }
    }

    // ── Apply token budget ────────────────────────────────────────
    const budget = this.budgeter.apply(chunks);

    // ── Build context snapshot for observability (§P0 — enriched) ─
    const contextSnapshot = {
      chunks: [
        ...budget.included.map((c) => ({
          id: c.id,
          source: c.source,
          priority: c.priority,
          tokenEstimate: c.tokenEstimate,
          included: true as const,
          trust: c.trust,
          sourceUri: c.sourceUri,
          score: c.metadata.score as number | undefined,
          warning: c.warning,
        })),
        ...budget.excluded.map((c) => ({
          id: c.id,
          source: c.source,
          priority: c.priority,
          tokenEstimate: c.tokenEstimate,
          included: false as const,
          reason: "token_budget" as const,
          trust: c.trust,
          sourceUri: c.sourceUri,
          score: c.metadata.score as number | undefined,
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

    if (ContextBuilder.DEBUG_TIMING) {
      console.debug(`[ContextBuilder] total_build_ms=${Date.now() - t0}`);
    }

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
      // §P0-3: Phase timing for trace observability
      timing: {
        groupAParallelMs,
        memorySearchMs,
        totalBuildMs: Date.now() - t0,
      },
    };
  }
}
