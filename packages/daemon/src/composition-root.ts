/**
 * Composition Root — 组装 Agent Loop 全部依赖的唯一入口。
 *
 * 这里是全部具体实现被"接线"的唯一位置。daemon server.ts 只需调用
 * createAgentLoopService 即可获得完全配置好的 AgentService。
 *
 * 装配层次：
 *   Foundation: EventBus → AbortRegistry → RunStateManager → EventSink → RunInitializer
 *   Context:    ContextBuilder（多数据源适配器）
 *   Intent:     IntentRouter（规则 + LLM 双路径）
 *   Tools:      ToolDecisionEngine（技能发现 + 意图匹配）
 *   Safety:     PermissionPolicy → ApprovalGate → ApprovalDecisionService
 *   Planner:    RuleBasedPlanner
 *   Execution:  SkillToolExecutor（统一工具执行入口）
 *   Reflection: BasicReflectionEngine
 *   Response:   ResponseComposer（LLM 流式输出 + 消息持久化）
 *   Memory:     DefaultMemoryWriter（显式/隐式记忆提取 + 脱敏 + 去重）
 *   Loop:       AgentLoopEngine（状态机，注入以上全部组件）
 *   Service:    AgentService（门面，注入 Loop + Abort + 幂等 + 审批裁决）
 *
 * 工具执行：
 * - 全部 skill 调用统一通过 SkillToolExecutor → SkillRunner 执行。
 * - skill catalog 使用全限定格式：<skill-id>:<capability-name>。
 */
import {
  type MemorySearchInput,
  type StepRecord,
} from "@sunpilot/protocol";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AbortRegistry,
  AgentLoopEngine,
  BasicReflectionEngine,
  ContextBuilder,
  DefaultMemoryWriter,
  DefaultToolArgumentBuilder,
  ExecutionOrchestrator,
  LlmEmbeddingService,
  SkillToolExecutor,
  InMemoryAgentEventBus,
  IntentRouter,
  PermissionPolicy,
  ResponseComposer,
  RuleBasedPlanner,
  RepositoryAgentEventSink,
  RepositoryAgentRunInitializer,
  RepositoryApprovalDecisionService,
  RepositoryApprovalGate,
  RepositoryApprovalRequestService,
  RepositoryRunStateManager,
  AgentService,
  type AgentEventBus,
  type AgentLoopServiceConfig,
  ToolDecisionEngine,
  type Permission,
  // ── New modules (architecture optimization §1–7) ─────────────────
  PlanValidator,
  Replanner,
  ModelRouter,
  OpenAICompatibleChatProvider,
  ToolRetriever,
  PromptInjectionDetector,
  ToolSandbox,
  TaskScopedPermissionManager,
  TraceManager,
  RepositoryTraceManager,
  SummaryStaleDetector,
  type ModelPurpose,
} from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import type { SkillRegistry } from "@sunpilot/skill-runner";

import {
  createDefaultEmbeddingProvider,
  type OpenAICompatibleEmbeddingProvider,
} from "@sunpilot/core";
import type { AttachmentRef, LlmProvider } from "@sunpilot/core";

export function createAgentLoopService(deps: {
  database: DatabaseContext;
  skillRegistry: SkillRegistry;
  skillRunner?: import("@sunpilot/skill-runner").SkillRunner;
  llmProvider: LlmProvider;
  eventBus?: AgentEventBus;
  /** Persisted-event bus for external consumers.
   *  Created internally if not provided. */
  liveEventBus?: AgentEventBus;
  systemPrompt?: string;
}): AgentService {
  // ── Foundation ─────────────────────────────────────────────────
  const rawEventBus = deps.eventBus ?? new InMemoryAgentEventBus();
  const liveEventBus = deps.liveEventBus ?? new InMemoryAgentEventBus();
  const abortRegistry = new AbortRegistry();
  const runStateManager = new RepositoryRunStateManager(deps.database);
  const eventSink = new RepositoryAgentEventSink(deps.database);
  const agentRunInitializer = new RepositoryAgentRunInitializer(deps.database);

  // Wire: rawEventBus → persist → liveEventBus.
  // Internal components emit to rawEventBus; the persist subscriber bridges
  // persisted events to liveEventBus, which WebSocket broadcasters and
  // external stream hooks consume. This ensures all externally visible
  // events carry a real DB sequence (no sequence: -1 duplicates).
  //
  // agent.message.part.delta is NOT persisted — it is a high-frequency transient
  // streaming event whose content is already captured by the final saved
  // message. Skipping it prevents the async fire-and-forget persist from
  // delivering response tokens out of order to liveEventBus.
  rawEventBus.subscribe(async (event) => {
    if (event.sequence !== undefined) {
      // Already persisted (e.g. atomically created with DB sequence) —
      // forward directly to liveEventBus without re-persisting.
      liveEventBus.publish(event);
      return;
    }
    if (event.type === "agent.message.part.delta") {
      // Transient streaming event — skip persist, delivered via sync onDelta
      return;
    }
    try {
      const persisted = await eventSink.persist(event);
      if (persisted) liveEventBus.publish(persisted);
    } catch (err) {
      console.error("[eventBus] Failed to persist event:", (err as Error).message);
    }
  });

  // ── Embedding ───────────────────────────────────────────────────
  // Try to create a real embedding provider from environment config.
  // Falls back to keyword/hash embedding when no API key is configured.
  let embeddingProvider: OpenAICompatibleEmbeddingProvider | undefined;
  try {
    embeddingProvider = createDefaultEmbeddingProvider();
  } catch {
    // No API key configured — will use fallback
  }

  const embeddingService = new LlmEmbeddingService({
    llm: deps.llmProvider,
    embeddingProvider,
  });

  // Log embedding mode at startup so operators know what's active
  if (embeddingService.hasRealProvider) {
    console.log(
      `[embedding] REAL provider active — model=${embeddingProvider!.model}, dims=${embeddingProvider!.dimensions}`,
    );
  } else {
    console.warn(
      "[embedding] FALLBACK mode — using keyword/hash vectors. Set SUNPILOT_LLM_API_KEY to enable semantic embeddings.",
    );
  }

  // ── Dual-Model Router (§dual-model) ──────────────────────────────
  // Two primary models (DP/DeepSeek + Seed/Volcengine Ark) as peer routes.
  // All purposes are served by both models. The user selects which one via
  // the model dropdown; the selection flows through request.modelId into
  // ModelRouter.streamChat() which picks the matching route.

  const allPurposes: ModelPurpose[] = [
    "intent_classification",
    "tool_argument_generation",
    "reflection",
    "response_composition",
    "summary_compression",
    "planning",
    "replanning",
    "clarification",
  ];

  // Resolve DP config: deps.llmProvider takes precedence when explicitly
  // provided (tests, single-provider deployments). Otherwise use env vars.
  const dpBaseUrl = process.env["SUNPILOT_DP_LLM_BASE_URL"] ?? process.env["SUNPILOT_LLM_BASE_URL"] ?? "https://api.deepseek.com";
  const dpModel = process.env["SUNPILOT_DP_LLM_MODEL"] ?? process.env["SUNPILOT_LLM_MODEL"] ?? "deepseek-v4-flash";
  const dpApiKey = process.env["SUNPILOT_DP_LLM_API_KEY"] ?? process.env["SUNPILOT_LLM_API_KEY"] ?? "";

  const dpProvider: LlmProvider = deps.llmProvider ?? new OpenAICompatibleChatProvider({
    id: "llm.deepseek",
    apiKey: dpApiKey,
    baseUrl: dpBaseUrl,
    model: dpModel,
  });
  const dpRouteModel = deps.llmProvider?.model ?? dpModel;
  console.log(`[llm] DP provider — model=${dpRouteModel} base=${dpBaseUrl} source=${deps.llmProvider ? "deps.llmProvider" : "env"}`);

  // Resolve Seed config — only provisioned when API key is set
  const seedBaseUrl = process.env["SUNPILOT_SEED_LLM_BASE_URL"] ?? "https://ark.cn-beijing.volces.com/api/v3";
  const seedModel = process.env["SUNPILOT_SEED_LLM_MODEL"] ?? "doubao-seed-2-0-lite-260428";
  const seedApiKey = process.env["SUNPILOT_SEED_LLM_API_KEY"] ?? "";

  const seedProvider = seedApiKey
    ? new OpenAICompatibleChatProvider({
        id: "llm.volcengine-ark",
        apiKey: seedApiKey,
        baseUrl: seedBaseUrl,
        model: seedModel,
      })
    : undefined;
  console.log(`[llm] Seed provider — model=${seedModel} base=${seedBaseUrl} available=${!!seedApiKey}`);

  const modelRouter = new ModelRouter({
    routes: [
      {
        purposes: allPurposes,
        priority: 0,
        modelId: "dp",
        config: {
          id: "dp",
          label: "DP",
          provider: dpProvider,
          model: dpRouteModel,
        },
      },
      ...(seedProvider
        ? [
            {
              purposes: allPurposes,
              priority: 1,
              modelId: "seed" as const,
              config: {
                id: "seed" as const,
                label: "Seed",
                provider: seedProvider,
                model: seedModel,
              },
            },
          ]
        : []),
    ],
    trackCalls: true,
    modelCallRecorder: deps.database.modelCalls,
  });

  // Purpose-specific LlmProvider adapters — each delegates to ModelRouter
  // with a fixed purpose so that model calls are tracked per-purpose.
  function createPurposeProvider(purpose: ModelPurpose): LlmProvider {
    return {
      id: `router:${purpose}`,
      model: modelRouter.getModelForPurpose(purpose),
      streamChat(request) {
        return modelRouter.streamChat(purpose, request);
      },
    };
  }

  const intentLlm = createPurposeProvider("intent_classification");
  const toolArgLlm = createPurposeProvider("tool_argument_generation");
  const reflectionLlm = createPurposeProvider("reflection");
  const responseLlm = createPurposeProvider("response_composition");
  const planningLlm = createPurposeProvider("planning");
  const replanningLlm = createPurposeProvider("replanning");

  // ── Context ────────────────────────────────────────────────────

  // SummaryStaleDetector — detects when conversation summaries need
  // regeneration due to goal-change, correction, fact-change, or
  // preference-conflict (§P0 of context optimization).
  const staleDetector = new SummaryStaleDetector();

  const contextBuilder = new ContextBuilder({
    staleDetector,
    listMessages: async (conversationId, limit) => {
      const messages =
        await deps.database.messages.listByConversationId(conversationId);
      return messages.slice(0, limit ?? 30).map((m) => ({
        id: m.id,
        role: m.role as string,
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
    searchMemories: async (input) => {
      try {
        // Use provided embedding or generate from query for hybrid search
        const queryEmbedding =
          input.embedding ??
          (input.query.trim()
            ? await embeddingService.embed(input.query).catch(() => undefined)
            : undefined);
        const memories = await deps.database.memory.search({
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
      const skills = deps.skillRegistry.list();
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
      const artifacts = await deps.database.artifacts.list(runId);
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
      const toolCalls = await deps.database.toolCalls.listByRunId(runId);
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
  });

  // ── Intent ─────────────────────────────────────────────────────
  // IntentRouter now uses a 4-layer cascade:
  //   Layer 0: form-match rules (slash commands, formulaic greetings)
  //   Layer 1: embedding semantic matching (primary tool selection)
  //   Layer 2: LLM classification (fallback for ambiguous queries)
  //   Layer 3: default 'unknown'
  // The embeddingService (Layer 1) handles ~80% of natural-language
  // tool selection, eliminating the old regex semantic-matching path
  // that caused false positives on queries like "搜索一下日照旅游攻略".
  const intentRouter = new IntentRouter({
    llm: intentLlm,
    embeddingService,
  });

  // ── Tools ──────────────────────────────────────────────────────
  // Shared argument builder — used by both ToolDecisionEngine (build)
  // and ExecutionOrchestrator (repair loop).
  const toolArgBuilder = new DefaultToolArgumentBuilder({
    llm: toolArgLlm,
  });

  // ToolRetriever — multi-layer tool retrieval pipeline (§2)
  // Uses embedding service for semantic similarity scoring when available.
  const toolRetriever = new ToolRetriever();

  // §Bugfix: Load JSON schema from file path when inputSchema is a string
  const loadSchema = (
    schema: string | Record<string, unknown> | undefined,
    skillPath: string,
  ): Record<string, unknown> | undefined => {
    if (typeof schema === "object" && schema !== null) return schema as Record<string, unknown>;
    if (typeof schema !== "string") return undefined;
    try {
      const filePath = join(skillPath, schema);
      if (existsSync(filePath)) {
        return JSON.parse(readFileSync(filePath, "utf-8"));
      }
    } catch { /* Best effort */ }
    return undefined;
  };

  // Shared helper — builds SkillSummary[] from skill registry (§refactor)
  const listSkillSummaries = async () => {
    const skills = deps.skillRegistry.list();
    return skills.flatMap((s) =>
      s.manifest.capabilities.map((capability) => {
        const permissions = normalizeCapabilityPermissions(capability.permissions);
        return {
          id: capabilityToolId(s.id, capability.name),
          name: capability.title,
          description: capability.description,
          category: categoryFromCapability(capability.name),
          enabled: s.enabled,
          permissions,
          defaultTimeoutMs: 60_000,
          maxTimeoutMs: 300_000,
          supportsAbort: true,
          idempotent: false,
          inputSchema: loadSchema(capability.inputSchema, s.path),
          // Populate outputSchema from manifest when available (§P2)
          outputSchema:
            typeof capability.outputSchema === "object" &&
            capability.outputSchema !== null
              ? (capability.outputSchema as Record<string, unknown>)
              : undefined,
          // Derive sideEffects from permissions heuristic (§P2).
          // Used by routing to reduce false-positive rate for destructive
          // tools. Exact classifications should eventually come from the
          // manifest itself when the schema is extended.
          sideEffects: classifySideEffects(permissions),
          riskHints: {
            defaultRisk: capability.risk as
              | "low"
              | "medium"
              | "high"
              | "critical",
          },
        };
      }),
    );
  };

  // ── Pre-warm embedding cache at startup ────────────────────────
  // Batch-embed all skill texts using rich embedding text (name +
  // description + category) so the first user request doesn't pay
  // the cold-start latency. Fire-and-forget — cache is an optimization.
  listSkillSummaries()
    .then((skills) => {
      const texts = skills.map((s) => buildSkillEmbeddingText(s));
      if (texts.length > 0) {
        embeddingService.preWarm(texts).catch((err) => {
          console.warn(
            "[embedding] pre-warm batch failed:",
            (err as Error).message,
          );
        });
      }
      console.log(
        `[embedding] pre-warm queued for ${texts.length} skill texts (cache size: ${embeddingService.cacheSize})`,
      );
    })
    .catch(() => {
      // Skill registry unavailable at startup — cache will populate on demand
    });

  // ── Safety ─────────────────────────────────────────────────────
  const permissionPolicy = new PermissionPolicy();
  const approvalGate = new RepositoryApprovalGate(deps.database);
  const approvalDecisionService = new RepositoryApprovalDecisionService(
    deps.database,
  );
  const approvalRequestService = new RepositoryApprovalRequestService(
    deps.database,
  );

  // ── Planner ────────────────────────────────────────────────────
  const planner = new RuleBasedPlanner();

  // ── Plan Validator (§1 of architecture next steps) ──────────────
  // Validates plans before execution for structural issues:
  // missing skills, circular deps, risk mismatches, destructive args.
  const planValidator = new PlanValidator({
    listSkills: listSkillSummaries,
  });

  // ── Replanner (§1 of architecture next steps) ──────────────────
  // Handles 6 trigger types: tool_failed, goal_changed,
  // approval_rejected, tool_result_insufficient, missing_parameters,
  // max_iterations_approaching.
  const replanner = new Replanner({
    listSkills: listSkillSummaries,
    llm: replanningLlm,
  });

  // ── Execution ──────────────────────────────────────────────────
  // Skill executor: delegates to SkillToolExecutor in core.
  const skillExecutor = new SkillToolExecutor({
    listSkills: () => deps.skillRegistry.list(),
    runSkill: async (step) => {
      if (!deps.skillRunner) {
        throw new Error(
          "SkillRunner is not configured for Agent tool execution.",
        );
      }
      return deps.skillRunner.execute(step);
    },
    createStep: async (step) => {
      await deps.database.steps.create({
        id: step.id,
        runId: step.runId,
        type: step.type as "skill" | "approval" | "builtin" | "manual",
        name: step.name,
        status: step.status as StepRecord["status"],
        skillId: step.skillId,
        input: step.input ?? {},
      });
    },
    updateStepStatus: (id, status, output, error) =>
      deps.database.steps.updateStatus(id, status, output, error),
    listArtifacts: async (runId) => deps.database.artifacts.list(runId),
  });

  const executionOrchestrator = new ExecutionOrchestrator({
    toolExecutor: skillExecutor,
    eventBus: rawEventBus,
    toolCalls: deps.database.toolCalls,
    argumentBuilder: toolArgBuilder,
  });

  // ── Tool Decision Engine ────────────────────────────────────────
  // Unified tool decision + streaming execution engine.
  // LLM native function calling interleaves text + tool calls —
  // Claude Code-style streaming UX. Falls back to traditional
  // safety + execution path on error.
  const toolDecisionEngine = new ToolDecisionEngine({
    listSkills: listSkillSummaries,
    llm: planningLlm,
    argumentBuilder: toolArgBuilder,
    toolRetriever,
    embeddingService,
    // Streaming execution deps
    eventBus: rawEventBus,
    modelRouter,
    permissionPolicy,
    executionOrchestrator,
    saveMessage: async (input) => {
      try {
        let embedding: number[] | undefined;
        if (input.content.trim()) {
          try {
            embedding = await embeddingService.embed(input.content);
          } catch {
            // Best effort
          }
        }
        await deps.database.messages.create({
          id: input.id,
          conversationId: input.conversationId,
          role: input.role as "system" | "user" | "assistant",
          content: input.content,
          metadata: input.metadata,
          embedding,
        });
      } catch {
        // Best effort
      }
    },
  });

  // ── Reflection ─────────────────────────────────────────────────
  const reflectionEngine = new BasicReflectionEngine({
    llm: reflectionLlm,
  });

  // ── Response ───────────────────────────────────────────────────
  const responseComposer = new ResponseComposer({
    llm: responseLlm,
    eventBus: rawEventBus,
    modelCalls: deps.database.modelCalls,
    saveMessage: async (input) => {
      try {
        // Generate embedding for semantic message search (best-effort)
        let embedding: number[] | undefined;
        if (input.content.trim()) {
          try {
            embedding = await embeddingService.embed(input.content);
          } catch {
            // Embedding generation failed — save without semantic index
          }
        }
        await deps.database.messages.create({
          id: input.id,
          conversationId: input.conversationId,
          role: input.role as "system" | "user" | "assistant",
          content: input.content,
          metadata: input.metadata,
          embedding,
        });
      } catch {
        // Best effort
      }
    },
  });

  // ── Memory ────────────────────────────────────────────────────
  const memoryWriter = new DefaultMemoryWriter({
    repository: deps.database.memory,
    embeddingService,
  });

  // ── Safety Hardening (§3, §4 of architecture next steps) ───────
  // PromptInjectionDetector — scans untrusted content for injection patterns.
  // Uses default patterns covering 6 categories (ignore_instructions,
  // system_prompt_leak, dangerous_tool_call, role_confusion,
  // delimiter_attack, data_exfiltration) with Chinese language support.
  const injectionDetector = new PromptInjectionDetector({
    blockCritical: true,
    warnOnMatch: true,
  });

  // ToolSandbox — validates tool execution against sandbox rules.
  // Mode from SUNPILOT_SANDBOX_MODE env var (strict|moderate|permissive),
  // defaults to "moderate" for local dev.
  const sandboxMode: "strict" | "moderate" | "permissive" =
    (typeof process !== "undefined" &&
      (process.env["SUNPILOT_SANDBOX_MODE"] === "strict" ||
       process.env["SUNPILOT_SANDBOX_MODE"] === "permissive")
        ? process.env["SUNPILOT_SANDBOX_MODE"] as "strict" | "permissive"
        : "moderate");
  const toolSandbox = new ToolSandbox(sandboxMode);
  console.log(`[sandbox] Mode: ${sandboxMode}`);

  // TaskScopedPermissionManager — enforces fine-grained permission
  // boundaries per run/step/tool_call with argument-change re-evaluation
  // and critical-risk forced re-approval.
  const scopedPermissionManager = new TaskScopedPermissionManager();

  // ── Trace Manager (§7, §P0-2 of architecture next steps) ──────
  // Creates trace/span per run for per-phase latency, token, and error
  // tracking. Uses RepositoryTraceManager when DB persistence is available
  // so traces survive daemon restarts.
  const tracePersistence = deps.database.agentTraces;
  const traceManager = tracePersistence
    ? new RepositoryTraceManager(tracePersistence, 1000)
    : new TraceManager(1000);

  // ── Loop Engine ────────────────────────────────────────────────
  const loopEngine = new AgentLoopEngine({
    contextBuilder,
    intentRouter,
    planner,
    toolDecisionEngine,
    executionOrchestrator,
    permissionPolicy,
    approvalGate,
    reflectionEngine,
    responseComposer,
    runStateManager,
    eventBus: rawEventBus,
    approvalRequestService,
    memoryWriter,
    // ── New optional modules (architecture optimization §1–7) ────
    planValidator,
    replanner,
    modelRouter,
    traceManager,
    injectionDetector,
    toolSandbox,
    scopedPermissionManager,
    // ── Plan snapshot persistence (§P0-2) ──────────────────────────
    planSnapshotRepo: deps.database.planSnapshots,
    // ── Tool call persistence for safety audits (§P0-3) ────────────
    toolCalls: deps.database.toolCalls,
    // ── Content-block stream message persistence (§Codex flow) ──────
    saveMessage: async (input) => {
      try {
        let embedding: number[] | undefined;
        if (input.content.trim()) {
          try {
            embedding = await embeddingService.embed(input.content);
          } catch { /* Best effort */ }
        }
        await deps.database.messages.create({
          id: input.id,
          conversationId: input.conversationId,
          role: input.role as "system" | "user" | "assistant",
          content: input.content,
          metadata: input.metadata,
          embedding,
        });
      } catch { /* Best effort */ }
    },
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

  return new AgentService(config);
}

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

function normalizeCapabilityPermissions(permissions: string[]): Permission[] {
  const normalized = permissions.flatMap((permission) => {
    switch (permission) {
      case "filesystem":
        return ["filesystem.read", "filesystem.write"] as Permission[];
      case "filesystem.read":
      case "filesystem.write":
      case "filesystem.delete":
      case "shell.execute":
      case "network.request":
      case "database.read":
      case "database.write":
      case "secret.read":
      case "artifact.write":
      case "memory.write":
      case "external.send":
        return [permission] as Permission[];
      case "shell":
        return ["shell.execute"] as Permission[];
      case "network":
      case "web":
        return ["network.request"] as Permission[];
      case "database":
      case "db":
        return ["database.read", "database.write"] as Permission[];
      case "env":
      case "secret":
        return ["secret.read"] as Permission[];
      case "artifact":
        return ["artifact.write"] as Permission[];
      case "memory":
        return ["memory.write"] as Permission[];
      default:
        return [];
    }
  });
  return [...new Set(normalized)];
}

/**
 * Classify side-effects from permissions heuristic (§P2).
 * Exact classification should come from the manifest when the
 * schema is extended. This heuristic provides useful signal for
 * routing (e.g., reducing destructive-tool false positives).
 */
function classifySideEffects(
  permissions: string[],
): "none" | "readonly" | "mutation" | "network" | "destructive" {
  if (permissions.includes("shell.execute")) return "destructive";
  if (permissions.includes("filesystem.write") || permissions.includes("filesystem.delete")) return "mutation";
  if (permissions.includes("network.request") || permissions.includes("external.send")) return "network";
  if (permissions.includes("database.write")) return "mutation";
  if (permissions.includes("filesystem.read") || permissions.includes("database.read") || permissions.includes("secret.read")) return "readonly";
  if (permissions.includes("artifact.write")) return "mutation";
  if (permissions.includes("memory.write")) return "mutation";
  return "none";
}

/**
 * Build rich embedding text from a SkillSummary (§P2).
 * Uses name + description + category for semantic vector generation.
 * If examples were available in the manifest, they'd be included here
 * (Tool2Vec approach: embed example user queries alongside descriptions).
 */
export function buildSkillEmbeddingText(skill: {
  name: string;
  description: string;
  category: string;
}): string {
  return `${skill.name} — ${skill.description} — category: ${skill.category}`;
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

