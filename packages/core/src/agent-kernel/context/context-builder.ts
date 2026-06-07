import type {
  AgentContext,
  AgentLoopInput,
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
 */
export class ContextBuilder implements ContextBuilderInterface {
  private readonly budgeter: TokenBudgeter;

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
    try {
      const messages = await this.deps.listMessages(input.conversationId, 30);
      for (const msg of messages) {
        if (msg.id === input.userMessageId) continue; // skip current
        chunks.push({
          id: `history_${msg.id}`,
          source: "conversation_history",
          title: `${msg.role} message`,
          content: msg.content,
          priority: 10,
          tokenEstimate: estimateTokens(msg.content),
          metadata: { messageId: msg.id, role: msg.role },
          createdAt: msg.createdAt,
        });
      }
    } catch {
      // Conversation store not available — skip history
    }

    // ── Memories ──────────────────────────────────────────────────
    if (this.deps.searchMemories) {
      try {
        const memories = await this.deps.searchMemories({
          query: input.message,
          runId: input.runId,
          conversationId: input.conversationId,
          userId: input.userId,
          limit: 10,
        });
        for (const mem of memories) {
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
      messages: budget.included
        .filter((c) => c.source === "conversation_history")
        .map((c) => ({
          role: (c.metadata.role as "user" | "assistant" | "system") ?? "user",
          content: c.content,
        })),
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
    };
  }
}
