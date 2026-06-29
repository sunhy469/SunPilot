/**
 * Model factory — wires the embedding provider, dual-model router (DP/Seed),
 * shared skill embedding cache, saveMessage helper, and the memory-summary
 * adapter. ReAct dialogue turns use ModelRouter directly.
 *
 * Extracted from composition-root.ts (Batch 4 §3).
 */
import type { DatabaseContext } from "@sunpilot/storage";
import {
  createDefaultEmbeddingProvider,
  LlmEmbeddingService,
  ModelRouter,
  OpenAICompatibleChatProvider,
  SkillEmbeddingCache,
  type Env,
  type LlmProvider,
  type ModelPurpose,
  type OpenAICompatibleEmbeddingProvider,
} from "@sunpilot/core";

export interface ModelFactoryDeps {
  database: DatabaseContext;
  env: Env;
  llmProvider?: LlmProvider;
  enableEnvironmentProviders?: boolean;
}

export interface ModelFactoryResult {
  embeddingService: LlmEmbeddingService;
  embeddingProvider: OpenAICompatibleEmbeddingProvider | undefined;
  skillEmbeddingCache: SkillEmbeddingCache;
  saveMessage: (input: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  modelRouter: ModelRouter;
  summaryLlm: LlmProvider;
}

export function createModelLayer(deps: ModelFactoryDeps): ModelFactoryResult {
  const { env, database } = deps;

  // ── Embedding ───────────────────────────────────────────────────
  // Try to create a real embedding provider from environment config.
  // Falls back to keyword/hash embedding when no API key is configured.
  let embeddingProvider: OpenAICompatibleEmbeddingProvider | undefined;
  if (deps.enableEnvironmentProviders) {
    try {
      embeddingProvider = createDefaultEmbeddingProvider();
    } catch {
      // No API key configured — will use fallback
    }
  }

  const embeddingService = new LlmEmbeddingService({
    embeddingProvider,
    dimension: env.SUNPILOT_EMBEDDING_DIMENSIONS,
  });

  const saveMessage = async (input: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }) => {
    let embedding: number[] | undefined;
    if (input.content.trim()) {
      try {
        embedding = await embeddingService.embed(input.content);
      } catch {
        /* Embedding is best effort. */
      }
    }
    await database.messages.create({
      id: input.id,
      conversationId: input.conversationId,
      role: input.role as "system" | "user" | "assistant",
      content: input.content,
      metadata: input.metadata,
      embedding,
    });
  };

  // Shared cache for capability-catalog retrieval.
  const skillEmbeddingCache = new SkillEmbeddingCache(embeddingService);

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
  const allPurposes: ModelPurpose[] = [
    "response_composition",
    "summary_compression",
  ];

  const dpBaseUrl = env.SUNPILOT_DP_LLM_BASE_URL ?? env.SUNPILOT_LLM_BASE_URL;
  const dpModel = env.SUNPILOT_DP_LLM_MODEL ?? env.SUNPILOT_LLM_MODEL;
  const dpApiKey = env.SUNPILOT_DP_LLM_API_KEY ?? env.SUNPILOT_LLM_API_KEY ?? env.DEEPSEEK_API_KEY ?? "";

  const dpProvider: LlmProvider = deps.llmProvider ?? new OpenAICompatibleChatProvider({
    id: "llm.deepseek",
    apiKey: dpApiKey,
    baseUrl: dpBaseUrl,
    model: dpModel,
  });
  const dpRouteModel = deps.llmProvider?.model ?? dpModel;
  console.log(`[llm] DP provider — model=${dpRouteModel} base=${dpBaseUrl} source=${deps.llmProvider ? "deps.llmProvider" : "env"}`);

  const seedBaseUrl = env.SUNPILOT_SEED_LLM_BASE_URL;
  const seedModel = env.SUNPILOT_SEED_LLM_MODEL;
  const seedApiKey = env.SUNPILOT_SEED_LLM_API_KEY ?? "";

  const seedProvider = deps.enableEnvironmentProviders && seedApiKey
    ? new OpenAICompatibleChatProvider({
        id: "llm.volcengine-ark",
        apiKey: seedApiKey,
        baseUrl: seedBaseUrl,
        model: seedModel,
      })
    : undefined;
  console.log(`[llm] Seed provider — model=${seedModel} base=${seedBaseUrl} available=${!!seedProvider}`);

  const modelRouter = new ModelRouter({
    routes: [
      ...(seedProvider
        ? [
            {
              purposes: allPurposes,
              priority: 0,
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
      {
        purposes: allPurposes,
        priority: 1,
        modelId: "dp",
        config: {
          id: "dp",
          label: "DP",
          provider: dpProvider,
          model: dpRouteModel,
        },
      },
    ],
    trackCalls: true,
    modelCallRecorder: database.modelCalls,
    onPersistFailure: (info) => {
      console.error(
        "[model-router] DB persist failed",
        { runId: info.runId, error: info.error },
      );
    },
  });

  function createPurposeProvider(purpose: ModelPurpose): LlmProvider {
    return {
      id: `router:${purpose}`,
      model: modelRouter.getModelForPurpose(purpose),
      streamChat(request) {
        return modelRouter.streamChat(purpose, request);
      },
    };
  }

  const summaryLlm = createPurposeProvider("summary_compression");

  return {
    embeddingService,
    embeddingProvider,
    skillEmbeddingCache,
    saveMessage,
    modelRouter,
    summaryLlm,
  };
}
