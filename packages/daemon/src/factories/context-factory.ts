/**
 * Context factory — wires context building, memory RAG/writes and tracing.
 *
 * Extracted from composition-root.ts (Batch 4 §3).
 */
import type { DatabaseContext } from "@sunpilot/storage";
import type { MemorySearchInput } from "@sunpilot/protocol";
import {
  ContextBuilder,
  DefaultMemoryWriter,
  LlmEmbeddingService,
  MemoryRetryWrapper,
  MmrMemoryReranker,
  MultiHopRetriever,
  RepositoryTraceManager,
  SimpleQueryExpander,
  SummaryStaleDetector,
  TraceManager,
  type AgentEventBus,
  type AttachmentRef,
  type LlmProvider,
} from "@sunpilot/core";
import type { SkillRegistry } from "@sunpilot/skill-runner";

export interface ContextFactoryDeps {
  database: DatabaseContext;
  rawEventBus: AgentEventBus;
  embeddingService: LlmEmbeddingService;
  summaryLlm: LlmProvider;
  skillRegistry: SkillRegistry;
  systemPrompt?: string;
}

export interface ContextFactoryResult {
  contextBuilder: ContextBuilder;
  rawMemoryWriter: DefaultMemoryWriter;
  memoryWriter: MemoryRetryWrapper;
  traceManager: RepositoryTraceManager | TraceManager;
}

export function createContextLayer(
  deps: ContextFactoryDeps,
): ContextFactoryResult {
  const { database, rawEventBus, embeddingService, skillRegistry } = deps;

  // ── Context ────────────────────────────────────────────────────
  const staleDetector = new SummaryStaleDetector();

  const contextBuilder = new ContextBuilder({
    staleDetector,
    summarizeMemory: async (content: string, maxChars: number) => {
      let summary = "";
      for await (const chunk of deps.summaryLlm.streamChat({
        messages: [
          {
            role: "system",
            content: `Summarize the following memory content in under ${maxChars} characters. Preserve key facts, preferences, and decisions. Output only the summary, no preamble.`,
          },
          { role: "user", content },
        ],
      })) {
        summary += chunk.delta;
      }
      return summary.trim();
    },
    listMessages: async (conversationId, limit) => {
      const messages =
        await database.messages.listByConversationId(conversationId);
      return messages.slice(0, limit ?? 30).map((m) => ({
        id: m.id,
        role: m.role as string,
        content: m.content,
        attachments: Array.isArray(m.metadata?.attachments)
          ? (m.metadata.attachments as AttachmentRef[])
          : undefined,
        createdAt: m.createdAt,
        parts: (m.metadata as { parts?: unknown })?.parts as
          | import("@sunpilot/protocol").AssistantMessagePart[]
          | undefined,
      }));
    },
    searchMessages: async (
      conversationId: string,
      embedding: number[],
      limit: number,
    ) => {
      const results = await database.messages.searchByEmbedding(
        conversationId,
        embedding,
        limit,
      );
      return results.map((m: { id: string; role: string; content: string; metadata: Record<string, unknown>; createdAt: string }) => ({
        id: m.id,
        role: m.role as string,
        content: m.content,
        attachments: Array.isArray(m.metadata?.attachments)
          ? (m.metadata.attachments as AttachmentRef[])
          : undefined,
        createdAt: m.createdAt,
      }));
    },
    searchMemories: async (input) => {
      try {
        const queryEmbedding =
          input.embedding ??
          (input.query.trim()
            ? await embeddingService.embed(input.query).catch(() => undefined)
            : undefined);
        const memories = await database.memory.search({
          query: input.query,
          runId: input.runId,
          conversationId: input.conversationId,
          userId: input.userId,
          limit: input.limit ?? 10,
          embedding: queryEmbedding,
          types: input.types as MemorySearchInput["types"],
          scopes: input.scopes as MemorySearchInput["scopes"],
        });
        return memories.map((memory) => ({
          id: memory.id,
          type: memory.type ?? "manual_note",
          title: memory.title ?? memory.key,
          content:
            memory.content ??
            (typeof memory.value === "string"
              ? memory.value
              : JSON.stringify(memory.value)),
          source: memory.source ?? "memory",
          confidence: memory.confidence ?? 0.8,
          scope: memory.scope,
          scopeId: memory.scopeId,
          score: memory.score,
          metadata: memory.metadata as Record<string, unknown> | undefined,
        }));
      } catch {
        return [];
      }
    },
    listSkills: async () => {
      const skills = skillRegistry.list();
      return skills
        .filter((skill) => skill.enabled)
        .flatMap((s) =>
          s.manifest.capabilities.map((capability) => ({
            id: capabilityToolId(s.id, capability.name),
            name: capability.title,
            description: capability.description,
            category: categoryFromCapability(capability.name),
          })),
        );
    },
    listArtifacts: async (runId) => {
      const artifacts = await database.artifacts.list(runId);
      return artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        type: artifact.type,
        summary:
          typeof artifact.metadata.content_summary === "string"
            ? artifact.metadata.content_summary
            : undefined,
      }));
    },
    listToolResults: async (runId) => {
      const toolCalls = await database.toolCalls.listByRunId(runId);
      return toolCalls.map((toolCall) => ({
        toolCallId: toolCall.id,
        name: toolCall.name,
        skillId: toolCall.skillId,
        status: toolCall.status,
        summary: toolResultSummary(toolCall.result),
        content: toolResultContent(toolCall.result),
        structured: toolResultStructured(toolCall.result),
      }));
    },
    systemPrompt: {
      persona:
        deps.systemPrompt ??
        "You are SunPilot, a concise and capable local agent assistant.",
      rules: [
        "Always respond in the same language as the user.",
        "Use tools when they help complete the task more effectively.",
        "Cite memory sources when using remembered information.",
      ],
    },
    embedText: async (text: string) => embeddingService.embed(text),
    eventBus: rawEventBus,
    memoryReranker: new MmrMemoryReranker({ lambda: 0.7 }),
    multiHopRetriever: new MultiHopRetriever({ maxHops: 2, topKPerHop: 5 }),
    queryExpander: new SimpleQueryExpander(),
    findRelatedMemories: async (memoryId, relation, limit) => {
      try {
        const related = await database.memory.findRelated(memoryId, relation, limit);
        return related.map((rm) => ({
          id: rm.id,
          type: rm.type ?? "manual_note",
          title: rm.title ?? "",
          content: rm.content ?? "",
          source: rm.source ?? "relation",
          confidence: rm.confidence ?? 0.5,
          scope: rm.scope,
          scopeId: rm.scopeId,
          score: rm.score,
        }));
      } catch {
        return [];
      }
    },
  });

  // ── Memory ────────────────────────────────────────────────────
  const rawMemoryWriter = new DefaultMemoryWriter({
    repository: database.memory,
    embeddingService,
  });
  const memoryWriter = new MemoryRetryWrapper(rawMemoryWriter, rawEventBus, {
    maxRetries: 2,
    baseDelayMs: 500,
  });

  // ── Trace Manager ──────────────────────────────────────────────
  const tracePersistence = database.agentTraces;
  const traceManager = tracePersistence
    ? new RepositoryTraceManager(tracePersistence, 1000)
    : new TraceManager(1000);

  return {
    contextBuilder,
    rawMemoryWriter,
    memoryWriter,
    traceManager,
  };
}

// ── Helper functions (shared with tool factory) ──────────────────

function capabilityToolId(skillId: string, capabilityName: string): string {
  return `${skillId}:${capabilityName}`;
}

function categoryFromCapability(
  capability: string,
):
  | "filesystem"
  | "shell"
  | "code"
  | "web"
  | "memory"
  | "artifact"
  | "automation"
  | "custom" {
  if (capability.startsWith("filesystem")) return "filesystem";
  if (capability.startsWith("shell")) return "shell";
  if (capability.startsWith("web") || capability.startsWith("network"))
    return "web";
  if (capability.startsWith("memory")) return "memory";
  if (capability.startsWith("artifact")) return "artifact";
  if (capability.startsWith("automation")) return "automation";
  if (capability.startsWith("code")) return "code";
  return "custom";
}

function toolResultSummary(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const summary = (result as { summary?: unknown }).summary;
  return typeof summary === "string" ? summary : undefined;
}

function toolResultContent(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function toolResultStructured(
  result: unknown,
): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const structured = (result as { structured?: unknown }).structured;
  return structured && typeof structured === "object"
    ? (structured as Record<string, unknown>)
    : undefined;
}
