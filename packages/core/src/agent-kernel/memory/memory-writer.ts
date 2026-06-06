import type { MemoryRecord, MemoryScope, MemoryType } from "@sunpilot/protocol";
import type {
  MemoryCandidate,
  MemoryPolicy,
  MemoryRepositoryPort,
  MemoryWriteInput,
  MemoryWriteResult,
  SecretRedactor,
} from "./memory-types.js";
import { DefaultMemoryPolicy } from "./memory-policy.js";
import { PatternSecretRedactor } from "./secret-redactor.js";

export interface DefaultMemoryWriterDeps {
  repository: MemoryRepositoryPort;
  policy?: MemoryPolicy;
  secretRedactor?: SecretRedactor;
  idGenerator?: () => string;
  clock?: () => Date;
}

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

      const record = await this.deps.repository.create(
        this.toRecord(candidate, input, secretScan.redactedText, decision.reason),
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

    if (input.observation && input.reflection?.goalAchieved) {
      const content = [
        input.observation.summary,
        input.reflection.summary,
      ].filter(Boolean).join("\n");
      if (content.trim()) {
        candidates.push({
          key: `task_summary:${input.input.runId}`,
          title: `Task summary for ${input.input.runId}`,
          content,
          summary: input.reflection.summary || input.observation.summary,
          type: "conversation_summary",
          scope: "conversation",
          scopeId: input.input.conversationId,
          source: "agent_task_summary",
          confidence: 0.7,
          importance: 0.55,
          reason: "completed tool task summary",
          metadata: {
            trigger: "completed_tool_task",
            artifactIds: input.observation.artifacts.map((artifact) => artifact.id),
            toolCallIds: input.observation.toolCalls.map((toolCall) => toolCall.id),
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
