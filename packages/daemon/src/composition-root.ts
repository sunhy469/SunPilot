/**
 * Composition Root — 组装 Agent Loop 全部依赖的唯一入口。
 *
 * 这里是全部具体实现被"接线"的唯一位置。daemon server.ts 只需调用
 * createAgentLoopService 即可获得完全配置好的 AgentService。
 *
 * 装配层次（每个工厂独立可测试）：
 *   Persistence: EventBus → AbortRegistry → RunStateManager → EventSink → RunInitializer
 *   Model:       EmbeddingProvider → ModelRouter → SkillEmbeddingCache → 6 purpose LLMs
 *   Context:     ContextBuilder + MemoryWriter + TraceManager
 *   Tool:        Catalog Retriever + Guard + ExecutionOrchestrator
 *   Safety:      PermissionPolicy → ApprovalGate → ToolSandbox → ToolSafetyBoundary
 *   Loop:        AgentLoopEngine（状态机，注入以上全部组件）
 *   Service:     AgentService（门面，注入 Loop + Abort + 幂等 + 审批裁决）
 *
 * 工具执行：
 * - 全部 skill 调用统一通过 SkillToolExecutor → SkillRunner 执行。
 * - skill catalog 使用全限定格式：<skill-id>:<capability-name>。
 */
import {
  AgentLoopEngine,
  ObservationBuilder,
  ReactLoopRunner,
  ReactModelTurn,
  RunStateReactCheckpointRepository,
  ReactToolExecutor,
  ToolCallGuard,
  ToolCatalogRetriever,
  AgentService,
  parseEnv,
  type AgentEventBus,
  type AgentLoopServiceConfig,
  type AttachmentRef,
  type LlmProvider,
  type ModelRouter,
  type SkillEmbeddingCache,
  type LlmEmbeddingService,
} from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import type { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";

import { createPersistenceLayer } from "./factories/persistence-factory.js";
import { createModelLayer } from "./factories/model-factory.js";
import { createContextLayer } from "./factories/context-factory.js";
import { createToolLayer } from "./factories/tool-factory.js";
import { createSafetyLayer } from "./factories/safety-factory.js";

export function createAgentLoopService(deps: {
  database: DatabaseContext;
  skillRegistry: SkillRegistry;
  skillRunner?: SkillRunner;
  /** Optional LLM provider. When omitted, one is constructed from env vars
   *  (SUNPILOT_DP_LLM_API_KEY → SUNPILOT_LLM_API_KEY) inside this function. */
  llmProvider?: LlmProvider;
  /** Enable model and embedding providers discovered from process.env.
   *  Dependency-injected tests leave this disabled so host secrets cannot
   *  silently supplement the supplied fake provider. */
  enableEnvironmentProviders?: boolean;
  eventBus?: AgentEventBus;
  /** Persisted-event bus for external consumers.
   *  Created internally if not provided. */
  liveEventBus?: AgentEventBus;
  systemPrompt?: string;
}): {
  service: AgentService;
  modelRouter: ModelRouter;
  updateMemory: (id: string, input: { content?: string; title?: string; summary?: string; confidence?: number; importance?: number }) => Promise<{ id: string } | null>;
  skillEmbeddingCache: SkillEmbeddingCache;
  embeddingService: LlmEmbeddingService;
  /** Stop persistence-layer background timers. */
  stopPersistence: () => void;
} {
  const env = parseEnv(process.env);

  // ── Persistence Layer ─────────────────────────────────────────
  const persistence = createPersistenceLayer({
    database: deps.database,
    eventBus: deps.eventBus,
    liveEventBus: deps.liveEventBus,
  });
  const { rawEventBus, liveEventBus, abortRegistry, runStateManager, agentRunInitializer } =
    persistence;

  // ── Model Layer ───────────────────────────────────────────────
  const model = createModelLayer({
    database: deps.database,
    env,
    llmProvider: deps.llmProvider,
    enableEnvironmentProviders: deps.enableEnvironmentProviders,
  });
  const {
    embeddingService,
    skillEmbeddingCache,
    saveMessage,
    modelRouter,
    summaryLlm,
  } = model;

  // ── Safety Layer ──────────────────────────────────────────────
  const safety = createSafetyLayer({
    database: deps.database,
    rawEventBus,
    sandboxMode: env.SUNPILOT_SANDBOX_MODE,
  });
  const { permissionPolicy, approvalGate, approvalDecisionService, toolSafetyBoundary } =
    safety;

  // ── Context Layer ─────────────────────────────────────────────
  const context = createContextLayer({
    database: deps.database,
    rawEventBus,
    embeddingService,
    summaryLlm,
    skillRegistry: deps.skillRegistry,
    systemPrompt: deps.systemPrompt,
  });
  const { contextBuilder, rawMemoryWriter, memoryWriter, traceManager } =
    context;

  // ── Tool Layer ─────────────────────────────────────────────────
  const tool = createToolLayer({
    database: deps.database,
    rawEventBus,
    skillRegistry: deps.skillRegistry,
    skillRunner: deps.skillRunner,
    toolSafetyBoundary,
  });
  const {
    listSkillSummaries,
    executionOrchestrator,
  } = tool;

  // ── ReAct Runtime ─────────────────────────────────────────────
  const observationBuilder = new ObservationBuilder(8_000);
  const reactCheckpoints = new RunStateReactCheckpointRepository(runStateManager);
  const reactLoopRunner = new ReactLoopRunner({
    listSkills: listSkillSummaries,
    retriever: new ToolCatalogRetriever({
      embeddingService,
      skillEmbeddingCache,
    }),
    modelTurn: new ReactModelTurn({ modelRouter, eventBus: rawEventBus }),
    guard: new ToolCallGuard(permissionPolicy, observationBuilder),
    executor: new ReactToolExecutor(executionOrchestrator, rawEventBus),
    checkpointRepository: reactCheckpoints,
    eventBus: rawEventBus,
  });

  // ── Loop Engine ────────────────────────────────────────────────
  const loopEngine = new AgentLoopEngine({
    contextBuilder,
    reactLoopRunner,
    executionOrchestrator,
    approvalGate,
    runStateManager,
    eventBus: rawEventBus,
    approvalRequestService: safety.approvalRequestService,
    memoryWriter,
    traceManager,
    saveMessage,
  });

  // ── Agent Service ──────────────────────────────────────────────
  const config: AgentLoopServiceConfig = {
    loopEngine,
    abortRegistry,
    eventBus: rawEventBus,
    liveEventBus,
    runStateManager,
    approvalGate,
    approvalDecisionService,
    agentRunInitializer,
    idempotency: deps.database.idempotency,
    database: deps.database,
    conversations: {
      createConversation: async (input) => {
        const conv = await deps.database.conversations.create({
          id: input?.id,
          title: input?.title,
        });
        return {
          id: conv.id,
          title: conv.title,
          status: "active" as const,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        };
      },
      findConversationById: async (id) => {
        const conv = await deps.database.conversations.findById(id);
        if (!conv) return null;
        return {
          id: conv.id,
          title: conv.title,
          status: "active" as const,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
        };
      },
      createMessage: async (input) => {
        // Generate embedding for semantic message search (best-effort).
        // Covers user, system, and assistant messages — the unified path
        // that was previously missing embedding for non-assistant roles.
        let embedding: number[] | undefined;
        if (input.content.trim()) {
          try {
            embedding = await embeddingService.embed(input.content);
          } catch {
            // Embedding unavailable — save without semantic index
          }
        }
        const msg = await deps.database.messages.create({
          id: input.id,
          conversationId: input.conversationId,
          role: input.role as "system" | "user" | "assistant",
          content: input.content,
          attachments: input.attachments,
          embedding,
        });
        const metadata = msg.metadata as {
          attachments?: Array<{
            id: string;
            name: string;
            type: string;
            sizeBytes?: number;
            url?: string;
            dataUrl?: string;
            storageKey?: string;
            provider?: "aliyun-oss" | "s3" | "minio" | "local";
            checksum?: string;
          }>;
        };
        return {
          id: msg.id,
          conversationId: msg.conversationId,
          role: msg.role,
          content: msg.content,
          attachments: metadata.attachments,
          createdAt: msg.createdAt,
        };
      },
      listMessages: async (conversationId) => {
        const msgs =
          await deps.database.messages.listByConversationId(conversationId);
        return msgs.map((m) => ({
          id: m.id,
          conversationId: m.conversationId,
          role: m.role as import("@sunpilot/core").AgentMessageRole,
          content: m.content,
          attachments: Array.isArray(m.metadata?.attachments)
            ? (m.metadata.attachments as AttachmentRef[])
            : undefined,
          createdAt: m.createdAt,
          /** §P0-3: Restore content-block parts from metadata. */
          parts: (m.metadata as { parts?: unknown })?.parts as
            | import("@sunpilot/protocol").AssistantMessagePart[]
            | undefined,
        }));
      },
    },
  };

  return {
    service: new AgentService(config),
    modelRouter,
    /** Expose updateMemory for API layer to trigger re-embedding on PATCH. */
    updateMemory: (id: string, input: { content?: string; title?: string; summary?: string; confidence?: number; importance?: number }) =>
      rawMemoryWriter.updateMemory(id, input),
    /** Expose for cache invalidation on skill registry reload. */
    skillEmbeddingCache,
    /** Expose for cache invalidation on skill registry reload. */
    embeddingService,
    stopPersistence: () => persistence.stop(),
  };
}
