import type { MemoryRecord, MemoryScope, MemoryType } from "@sunpilot/protocol";
import type {
  MemoryCandidate,
  MemoryPolicy,
  MemoryRepositoryPort,
  MemoryWriteInput,
  MemoryWriteResult,
  SecretRedactor,
} from "./memory-types.js";
import type { EmbeddingService } from "../context/embedding-service.js";
import { DefaultMemoryPolicy } from "./memory-policy.js";
import { PatternSecretRedactor } from "./secret-redactor.js";

export interface DefaultMemoryWriterDeps {
  repository: MemoryRepositoryPort;
  policy?: MemoryPolicy;
  secretRedactor?: SecretRedactor;
  /** Optional embedding service for semantic memory retrieval. */
  embeddingService?: EmbeddingService;
  idGenerator?: () => string;
  clock?: () => Date;
}

/**
 * DefaultMemoryWriter — 记忆写入器。
 *
 * 写入流程（writeFromTurn）：
 * 1. extractCandidates：从 turn 中提取候选记忆
 *    - 用户显式"记住"关键词 → 高置信度候选
 *    - 意图为 memory_update → 中置信度候选
 *    - 工具任务完成 → 自动生成 task_summary 候选
 * 2. secretRedactor.scan：扫描敏感信息（密钥、密码等）并脱敏
 * 3. 查重：检索相似记忆，交由 memoryPolicy 决定 write/supersede/reject
 * 4. 写入或拒写，记录决策理由
 */
export class DefaultMemoryWriter {
  private readonly policy: MemoryPolicy;
  private readonly secretRedactor: SecretRedactor;
  private readonly idGenerator: () => string;
  private readonly clock: () => Date;

  constructor(private readonly deps: DefaultMemoryWriterDeps) {
    this.policy = deps.policy ?? new DefaultMemoryPolicy();
    this.secretRedactor = deps.secretRedactor ?? new PatternSecretRedactor();
    this.idGenerator = deps.idGenerator ?? (() => `memory_${crypto.randomUUID()}`);
    this.clock = deps.clock ?? (() => new Date());
  }

  async writeFromTurn(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    const candidates = this.extractCandidates(input);
    const written: MemoryRecord[] = [];
    const rejected: MemoryWriteResult["rejected"] = [];
    const superseded: MemoryWriteResult["superseded"] = [];

    for (const candidate of candidates) {
      const secretScan = this.secretRedactor.scan(candidate.content);
      const similar = await this.deps.repository.search({
        query: candidate.title,
        runId: candidate.scope === "run" ? input.input.runId : undefined,
        conversationId: candidate.scope === "conversation" ? input.input.conversationId : undefined,
        userId: candidate.scope === "user" ? input.input.userId : undefined,
        scopes: [candidate.scope],
        types: [candidate.type],
        limit: 5,
      });
      const decision = this.policy.classify({ candidate, secretScan, similar });
      if (decision.action === "reject") {
        rejected.push({ candidate, reason: decision.reason });
        continue;
      }

      // Generate semantic embedding for hybrid retrieval (best-effort)
      let embedding: number[] | undefined;
      if (this.deps.embeddingService) {
        try {
          embedding = await this.deps.embeddingService.embed(
            secretScan.redactedText,
          );
        } catch {
          // Embedding generation failed — continue without semantic index
        }
      }

      const record = await this.deps.repository.create(
        this.toRecord(candidate, input, secretScan.redactedText, decision.reason, embedding),
      );
      written.push(record);

      if (decision.action === "supersede" && decision.supersedeMemoryId) {
        await this.deps.repository.supersede(decision.supersedeMemoryId, record.id);
        superseded.push({ oldMemoryId: decision.supersedeMemoryId, newMemoryId: record.id });
      }
    }

    return { written, rejected, superseded };
  }

  extractCandidates(input: MemoryWriteInput): MemoryCandidate[] {
    const candidates: MemoryCandidate[] = [];
    const message = input.input.message.trim();
    const explicit = extractExplicitMemory(message);

    if (explicit) {
      const type = classifyMemoryType(explicit);
      const scope = defaultScopeForType(type, input.input.userId);
      candidates.push({
        key: keyFor(type, explicit),
        title: titleFor(type, explicit),
        content: explicit,
        summary: explicit,
        type,
        scope,
        scopeId: scopeIdFor(scope, input),
        source: "user_explicit",
        confidence: 0.92,
        importance: 0.75,
        reason: "user explicitly asked SunPilot to remember this",
        metadata: { trigger: "explicit_remember" },
      });
    }

    if (!explicit && input.intent.type === "memory_update") {
      const type = classifyMemoryType(message);
      const scope = defaultScopeForType(type, input.input.userId);
      candidates.push({
        key: keyFor(type, message),
        title: titleFor(type, message),
        content: message,
        summary: message,
        type,
        scope,
        scopeId: scopeIdFor(scope, input),
        source: "memory_update_intent",
        confidence: 0.72,
        importance: 0.62,
        reason: "intent router classified the turn as a memory update",
        metadata: { trigger: "memory_update_intent" },
      });
    }

    // Generate conversation summary when:
    // 1. A tool task completes successfully (goalAchieved), OR
    // 2. The conversation has grown large (forceSummary — token or turn trigger), OR
    // 3. Rolling trigger: every 8 tool turns to keep summary incremental
    const turnCount =
      input.observation?.toolCalls.length ?? 0;
    const shouldRollingSummarize =
      input.observation &&
      turnCount > 0 &&
      (input.context.messages.length >= 20 || turnCount >= 8);
    const shouldSummarize =
      input.observation &&
      (input.reflection?.goalAchieved ||
        input.forceSummary ||
        shouldRollingSummarize);
    if (shouldSummarize && input.observation) {
      const obs = input.observation;
      const refl = input.reflection;
      const toolDetails = obs.toolCalls
        .map((tc) => `- ${tc.name} (${tc.skillId}): ${tc.status} — ${tc.summary}`)
        .join("\n");
      const artifactDetails = obs.artifacts
        .map((a) => `- ${a.name} (${a.type})`)
        .join("\n");
      const structuredFacts = obs.toolCalls
        .filter((tc) => tc.structured)
        .map((tc) => {
          const s = tc.structured!;
          const total =
            s.totalResults ??
            (Array.isArray(s.candidates)
              ? (s.candidates as unknown[]).length
              : Array.isArray(s.results)
                ? (s.results as unknown[]).length
                : undefined);
          return total !== undefined
            ? `${tc.name}: ${total} results`
            : `${tc.name}: completed`;
        })
        .join(", ");

      const goalText = refl?.summary ?? "Conversation progress";
      const content = [
        `Goal: ${goalText}`,
        obs.summary ? `Summary: ${obs.summary}` : "",
        toolDetails ? `Tools executed:\n${toolDetails}` : "",
        structuredFacts ? `Results: ${structuredFacts}` : "",
        artifactDetails ? `Artifacts created:\n${artifactDetails}` : "",
        refl?.missingInfo?.length
          ? `Open questions: ${refl.missingInfo.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      if (content.trim()) {
        // Determine the message range this summary covers.
        const range = input.messageRange ?? {
          fromMessageId: input.input.userMessageId,
          toMessageId: input.input.userMessageId,
        };

        // ── Quality scoring ──────────────────────────────────────────
        // Derive quality from reflection confidence, tool result richness,
        // and whether any tools failed. This feeds into stale detection
        // and summary prioritization in ContextBuilder.
        const toolSuccessRate =
          obs.toolCalls.length > 0
            ? obs.toolCalls.filter((tc) => tc.status === "completed").length /
              obs.toolCalls.length
            : 1;
        const reflConfidence = refl?.confidence ?? 0.7;
        const hasArtifacts = obs.artifacts.length > 0;
        const hasQuestions = (refl?.missingInfo?.length ?? 0) > 0;
        const qualityScore = Math.round(
          (reflConfidence * 0.4 + toolSuccessRate * 0.3 +
            (hasArtifacts ? 0.15 : 0) + (hasQuestions ? 0 : 0.15)) * 100,
        ) / 100; // 0.0–1.0

        // Dynamic importance: goal-achieved summaries more important
        const dynImportance = refl?.goalAchieved
          ? 0.75
          : input.forceSummary
            ? 0.65
            : 0.55;

        // Summary version: increment for rolling updates
        const summaryVersion =
          (typeof input.context?.messages?.length === "number"
            ? Math.floor(input.context.messages.length / 10)
            : 1);
        const now = new Date().toISOString();

        candidates.push({
          key: `task_summary:${input.input.runId}`,
          title: `Task: ${goalText.slice(0, 80)}`,
          content,
          summary: refl?.summary ?? obs.summary,
          type: "conversation_summary",
          scope: "conversation",
          scopeId: input.input.conversationId,
          source: "agent_task_summary",
          confidence: qualityScore,
          importance: dynImportance,
          reason: "completed tool task summary with structured results",
          metadata: {
            trigger: refl?.goalAchieved
              ? "completed_tool_task"
              : input.forceSummary
                ? "force_summary"
                : shouldRollingSummarize
                  ? "rolling_turn_trigger"
                  : "manual",
            runId: input.input.runId,
            artifactIds: obs.artifacts.map((a) => a.id),
            toolCallIds: obs.toolCalls.map((tc) => tc.id),
            goalAchieved: refl?.goalAchieved ?? false,
            confidence: refl?.confidence,
            timestamp: now,
            // Rolling summary range: tracks which messages are covered
            // ContextBuilder uses this to exclude summarized messages.
            messageRange: range,
            // Quality feedback loop fields
            quality: {
              score: qualityScore,
              toolSuccessRate,
              reflectionConfidence: reflConfidence,
              hasArtifacts,
              hasOpenQuestions: hasQuestions,
              toolCount: obs.toolCalls.length,
            },
            version: summaryVersion,
            updatedAt: now,
          },
        });
      }
    }

    return candidates;
  }

  private toRecord(
    candidate: MemoryCandidate,
    input: MemoryWriteInput,
    redactedContent: string,
    policyReason: string,
    embedding?: number[],
  ): MemoryRecord {
    const now = this.clock().toISOString();
    return {
      id: this.idGenerator(),
      runId: input.input.runId,
      key: candidate.key,
      value: redactedContent,
      scope: candidate.scope,
      scopeId: candidate.scopeId,
      type: candidate.type,
      title: candidate.title,
      content: redactedContent,
      summary: candidate.summary ?? redactedContent,
      source: candidate.source,
      confidence: candidate.confidence,
      importance: candidate.importance,
      embedding,
      metadata: {
        ...candidate.metadata,
        conversationId: input.input.conversationId,
        userId: input.input.userId,
        responseMessageId: input.responseMessageId,
        policyReason,
      },
      createdAt: now,
      updatedAt: now,
    };
  }
}

function extractExplicitMemory(message: string): string | undefined {
  const patterns = [
    /(?:remember|please remember|save this|keep in memory)[:：]?\s*(.+)$/i,
    /(?:记住|请记住|帮我记住|保存这条记忆)[:：]?\s*(.+)$/,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
}

function classifyMemoryType(content: string): MemoryType {
  const normalized = content.toLowerCase();
  if (/prefer|preference|喜欢|偏好|习惯/.test(normalized)) return "user_preference";
  if (/deploy|deployment|docker|kubernetes|上线|部署/.test(normalized)) return "deployment_info";
  if (/typescript|react|node|java|spring|postgres|技术栈|框架/.test(normalized)) return "technical_stack";
  if (/goal|目标|长期/.test(normalized)) return "long_term_goal";
  if (/error|fix|solution|报错|错误|解决/.test(normalized)) return "error_solution";
  if (/project|项目|repo|仓库/.test(normalized)) return "project_profile";
  return "manual_note";
}

function defaultScopeForType(type: MemoryType, userId?: string): MemoryScope {
  if (type === "user_preference" && userId) return "user";
  return "conversation";
}

function scopeIdFor(scope: MemoryScope, input: MemoryWriteInput): string | undefined {
  switch (scope) {
    case "user":
      return input.input.userId;
    case "conversation":
      return input.input.conversationId;
    case "run":
      return input.input.runId;
    default:
      return undefined;
  }
}

function keyFor(type: MemoryType, content: string): string {
  return `${type}:${slug(content).slice(0, 48)}`;
}

function titleFor(type: MemoryType, content: string): string {
  const title = content.replace(/\s+/g, " ").trim().slice(0, 80);
  return title || type;
}

function slug(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "memory";
}
