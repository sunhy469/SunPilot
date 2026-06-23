import type { LlmProvider, ChatCompletionRequest, ChatCompletionDelta } from "../llm/llm.types.js";

// ── Model Purpose ────────────────────────────────────────────────────────

/**
 * ModelPurpose categorizes each LLM call by its role in the Agent Loop.
 * This enables routing calls to different models optimized for each task,
 * and tracking cost/latency by purpose (§3 of architecture next steps).
 */
export type ModelPurpose =
  | "intent_classification"
  | "tool_argument_generation"
  | "reflection"
  | "response_composition"
  | "summary_compression"
  | "embedding"
  | "planning"
  | "replanning"
  | "clarification";

// ── Model Config ─────────────────────────────────────────────────────────

export interface ModelConfig {
  /** Stable model identifier — matches ChatModelId for user-selectable models. */
  id?: "dp" | "seed";
  /** Human-readable label for UI display. */
  label?: string;
  /** Provider instance. */
  provider: LlmProvider;
  /** Model name for tracking. */
  model: string;
  /** Token cost per 1K input tokens (USD). Approximate. */
  inputCostPer1K?: number;
  /** Token cost per 1K output tokens (USD). Approximate. */
  outputCostPer1K?: number;
}

export interface ModelRoute {
  /** Which purposes this model serves. */
  purposes: ModelPurpose[];
  /** Priority (lower = higher priority within the same purpose). */
  priority: number;
  /** Model configuration. */
  config: ModelConfig;
  /**
   * Optional model ID filter. When set, this route only matches
   * requests with the same modelId. Used for user-selected model routing.
   */
  modelId?: "dp" | "seed";
}

/** Minimal interface for writing model call records to DB (§P1-5).
 *  Compatible with ModelCallRepository.create from @sunpilot/storage. */
export interface ModelCallRecorder {
  create(input: {
    id?: string;
    runId?: string;
    provider: string;
    model: string;
    purpose: string;
    inputTokens?: number;
    outputTokens?: number;
    latencyMs?: number;
    costEstimate?: number;
    status?: string;
    error?: unknown;
    metadata?: Record<string, unknown>;
    createdAt?: string;
  }): Promise<unknown>;
}

export interface ModelRouterConfig {
  /** Ordered list of model routes. First matching route wins. */
  routes: ModelRoute[];
  /** Fallback model when the primary route's provider fails. */
  fallback?: ModelConfig;
  /** Whether to track model calls for observability. */
  trackCalls?: boolean;
  /** Optional DB recorder for persisting model calls (§P1-5). */
  modelCallRecorder?: ModelCallRecorder;
  /** §P2-2: Callback invoked when a model call DB persist fails. */
  onPersistFailure?: (info: { runId?: string; error: string }) => void;
}

// ── Model Call Record ───────────────────────────────────────────────────

export interface ModelCallRecord {
  /** Unique call ID. */
  callId: string;
  /** The run this call belongs to (§P1-5). */
  runId?: string;
  /** Which purpose this call served. */
  purpose: ModelPurpose;
  /** The model that was actually used. */
  model: string;
  /** The provider that was used. */
  providerId: string;
  /** Latency in milliseconds. */
  latencyMs: number;
  /** Estimated input tokens. */
  inputTokensEstimate: number;
  /** Estimated output tokens. */
  outputTokensEstimate: number;
  /** Whether fallback was used. */
  fallbackUsed: boolean;
  /** Reason for fallback if used. */
  fallbackReason?: string;
  /** When the call started. */
  startedAt: string;
  /** Any error that occurred. */
  error?: string;
}

export interface ModelRouterStats {
  /** Total calls routed. */
  totalCalls: number;
  /** Calls per purpose. */
  callsByPurpose: Record<string, number>;
  /** Total estimated cost (USD). */
  totalCostEstimate: number;
  /** Fallback count. */
  fallbackCount: number;
  /** Recent call records (last 100). */
  recentCalls: ModelCallRecord[];
  /** Number of persistence failures (DB write errors). */
  persistFailures: number;
}

/**
 * ModelRouter — routes LLM calls to the most appropriate model based on purpose.
 *
 * Design (§3):
 * - intent_classification → low-cost model
 * - tool_argument_generation → structured-output capable model
 * - reflection → stable reasoning model
 * - response_composition → primary dialogue model
 * - summary_compression → low-cost long-context model
 * - embedding → dedicated embedding provider
 *
 * Fallback: if the primary model fails, falls back to the next matching
 * route or the configured fallback model. Never silently fails a run.
 */
export class ModelRouter {
  private readonly routes: ModelRoute[];
  private readonly fallback?: ModelConfig;
  private readonly trackCalls: boolean;
  private readonly callRecords: ModelCallRecord[] = [];
  private readonly modelCallRecorder?: ModelCallRecorder;
  private readonly onPersistFailure?: ModelRouterConfig["onPersistFailure"];
  private persistFailures = 0;

  constructor(config: ModelRouterConfig) {
    // Sort routes by priority within each purpose
    this.routes = [...config.routes].sort((a, b) => a.priority - b.priority);
    this.fallback = config.fallback;
    this.trackCalls = config.trackCalls ?? true;
    this.modelCallRecorder = config.modelCallRecorder;
    this.onPersistFailure = config.onPersistFailure;
  }

  /**
   * Route a chat request to the best model for the given purpose.
   * Returns an async generator that yields deltas.
   *
   * On provider failure, automatically falls back to the next best route
   * or the configured fallback model.
   */
  async *streamChat(
    purpose: ModelPurpose,
    request: ChatCompletionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ChatCompletionDelta> {
    const requestWithSignal: ChatCompletionRequest = {
      ...request,
      signal: signal ?? request.signal,
    };

    // ── Route selection with optional modelId filter ──
    // 1. If request.modelId is set, only use routes matching that modelId
    // 2. Otherwise, use all routes serving this purpose
    let matchingRoutes = this.routes.filter((r) =>
      r.purposes.includes(purpose),
    );

    if (request.modelId) {
      const modelRoutes = matchingRoutes.filter(
        (r) => r.modelId === request.modelId,
      );
      if (modelRoutes.length === 0) {
        throw new Error(
          `Model "${request.modelId}" is not configured for purpose "${purpose}". ` +
          `Available models: ${[...new Set(matchingRoutes.map((r) => r.modelId).filter(Boolean))].join(", ") || "none"}.`,
        );
      }
      matchingRoutes = modelRoutes;
    }

    if (matchingRoutes.length === 0 && !this.fallback) {
      throw new Error(
        `No model route configured for purpose "${purpose}" and no fallback available.`,
      );
    }

    const callId = request.modelCallId ?? `model_call_${crypto.randomUUID()}`;
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    let outputTokens = 0;
    let fallbackUsed = false;
    let fallbackReason: string | undefined;
    let usedModel = "unknown";
    let usedProviderId = "unknown";
    let lastError: string | undefined;

    // Try each matching route in priority order
    const providersToTry = [
      ...matchingRoutes.map((r) => r.config),
      ...(this.fallback ? [this.fallback] : []),
    ];

    for (const config of providersToTry) {
      try {
        usedModel = config.model;
        usedProviderId = config.provider.id;

        for await (const delta of config.provider.streamChat(
          requestWithSignal,
        )) {
          outputTokens += estimateDeltaTokens(delta.delta);
          yield delta;
        }

        // Success — record in-memory and persist to DB (§P1-5)
        const latencyMs = Date.now() - startTime;
        const inputTokens = estimateInputTokens(request);
        this.recordCall({
          callId,
          runId: request.runId,
          purpose,
          model: usedModel,
          providerId: usedProviderId,
          latencyMs,
          inputTokensEstimate: inputTokens,
          outputTokensEstimate: outputTokens,
          fallbackUsed,
          fallbackReason,
          startedAt,
        });
        // Persist model call to DB — await to surface failures (§P1-5)
        if (this.modelCallRecorder) {
          this.modelCallRecorder.create({
            id: callId,
            runId: request.runId,
            provider: usedProviderId,
            model: usedModel,
            purpose,
            inputTokens,
            outputTokens,
            latencyMs,
            status: "completed",
            metadata: request.metadata,
            createdAt: startedAt,
          }).catch(() => { this.persistFailures++; this.onPersistFailure?.({ runId: request.runId, error: "DB persist failed for completed model call" }); });
        }
        return;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        lastError = err.message;

        if (signal?.aborted) {
          // Don't fallback on abort
          throw error;
        }

        // Try next provider
        fallbackUsed = true;
        fallbackReason = `Provider "${usedProviderId}" failed: ${err.message}`;
        continue;
      }
    }

    // All providers failed — record in-memory and persist (§P1-5)
    const finalLatency = Date.now() - startTime;
    const finalInput = estimateInputTokens(request);
    this.recordCall({
      callId,
      runId: request.runId,
      purpose,
      model: usedModel,
      providerId: usedProviderId,
      latencyMs: finalLatency,
      inputTokensEstimate: finalInput,
      outputTokensEstimate: 0,
      fallbackUsed: true,
      fallbackReason: `All providers exhausted. Last error: ${lastError}`,
      startedAt,
      error: lastError,
    });
    if (this.modelCallRecorder) {
      this.modelCallRecorder.create({
        id: callId,
        runId: request.runId,
        provider: usedProviderId,
        model: usedModel,
        purpose,
        inputTokens: finalInput,
        outputTokens: 0,
        latencyMs: finalLatency,
        status: "failed",
        error: lastError,
        metadata: request.metadata,
        createdAt: startedAt,
      }).catch(() => { this.persistFailures++; this.onPersistFailure?.({ runId: request.runId, error: "DB persist failed for failed model call" }); });
    }

    throw new Error(
      `All model providers failed for purpose "${purpose}". Last error: ${lastError}`,
    );
  }

  /**
   * Get the configured model name for a purpose (without making a call).
   * Useful for metadata tracking.
   */
  getModelForPurpose(purpose: ModelPurpose): string {
    const route = this.routes.find((r) => r.purposes.includes(purpose));
    return route?.config.model ?? this.fallback?.model ?? "unknown";
  }

  /**
   * Get routing statistics.
   */
  getStats(): ModelRouterStats {
    const callsByPurpose: Record<string, number> = {};
    let totalCostEstimate = 0;
    let fallbackCount = 0;

    for (const call of this.callRecords) {
      callsByPurpose[call.purpose] =
        (callsByPurpose[call.purpose] ?? 0) + 1;
      if (call.fallbackUsed) fallbackCount++;

      // Estimate cost
      const route = this.routes.find(
        (r) => r.config.model === call.model,
      );
      const inputCost =
        (route?.config.inputCostPer1K ?? 0) *
        (call.inputTokensEstimate / 1000);
      const outputCost =
        (route?.config.outputCostPer1K ?? 0) *
        (call.outputTokensEstimate / 1000);
      totalCostEstimate += inputCost + outputCost;
    }

    return {
      totalCalls: this.callRecords.length,
      callsByPurpose,
      totalCostEstimate: Math.round(totalCostEstimate * 10000) / 10000,
      fallbackCount,
      recentCalls: this.callRecords.slice(-100),
      persistFailures: this.persistFailures,
    };
  }

  /**
   * Clear call records (e.g., between test runs).
   */
  clearRecords(): void {
    this.callRecords.length = 0;
  }

  private recordCall(record: ModelCallRecord): void {
    if (this.trackCalls) {
      this.callRecords.push(record);
      // Keep only last 1000 records
      if (this.callRecords.length > 1000) {
        this.callRecords.splice(0, this.callRecords.length - 1000);
      }
    }
  }
}

// ── Token Estimation Helpers ────────────────────────────────────────────

function estimateInputTokens(request: ChatCompletionRequest): number {
  return request.messages.reduce(
    (sum, msg) => sum + Math.ceil(msg.content.length / 4),
    0,
  );
}

function estimateDeltaTokens(delta: string): number {
  return Math.ceil(delta.length / 4);
}

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Create a simple ModelRouter with a single provider for all purposes.
 * This is the default when no multi-model routing is configured.
 */
export function createSingleModelRouter(
  provider: LlmProvider,
  model?: string,
  modelCallRecorder?: ModelCallRecorder,
): ModelRouter {
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

  return new ModelRouter({
    routes: [
      {
        purposes: allPurposes,
        priority: 0,
        config: {
          provider,
          model: model ?? provider.model,
        },
      },
    ],
    modelCallRecorder,
  });
}

/**
 * Create a ModelRouter with separate providers for different purpose tiers.
 *
 * Tier 1 (low-cost): intent_classification, summary_compression
 * Tier 2 (reasoning): reflection, planning, replanning
 * Tier 3 (primary): response_composition, tool_argument_generation, clarification
 */
export function createTieredModelRouter(params: {
  lowCost: ModelConfig;
  reasoning?: ModelConfig;
  primary: ModelConfig;
  fallback?: ModelConfig;
}): ModelRouter {
  const routes: ModelRoute[] = [
    {
      purposes: ["intent_classification", "summary_compression"],
      priority: 0,
      config: params.lowCost,
    },
  ];

  if (params.reasoning) {
    routes.push({
      purposes: ["reflection", "planning", "replanning"],
      priority: 1,
      config: params.reasoning,
    });
  }

  routes.push({
    purposes: [
      "response_composition",
      "tool_argument_generation",
      "clarification",
    ],
    priority: params.reasoning ? 2 : 1,
    config: params.primary,
  });

  return new ModelRouter({
    routes,
    fallback: params.fallback ?? params.primary,
  });
}
