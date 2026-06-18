import type { EmbeddingProvider } from "../agent-kernel/context/llm-embedding-service.js";
import {
  DEFAULT_LLM_BASE_URL,
  DEEPSEEK_API_KEY_ENV,
  LLM_API_KEY_ENV,
} from "./llm.config.js";
import type { FetchLike } from "./llm.types.js";

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
  model?: string;
}

/**
 * OpenAI-compatible Embedding Provider.
 *
 * Calls the /embeddings endpoint on an OpenAI-compatible API (OpenAI, DeepSeek, etc.)
 * to generate real semantic embedding vectors. Falls back gracefully: callers should
 * catch errors and use keyword/hash fallback via LlmEmbeddingService.
 *
 * Configured via the same env vars as the chat provider:
 *   SUNPILOT_LLM_API_KEY (or DEEPSEEK_API_KEY)
 *   SUNPILOT_LLM_BASE_URL
 */
export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  /** Provider identifier for logging and metadata. */
  readonly id = "embedding.openai-compatible";
  /** The embedding model in use (e.g. text-embedding-3-small). */
  readonly model: string;
  /** Embedding vector dimension. */
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    config: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
      dimensions?: number;
    },
    fetchImpl: FetchLike = fetch,
  ) {
    if (!config.apiKey.trim()) {
      throw new Error(`${LLM_API_KEY_ENV} is required for embedding provider.`);
    }
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_LLM_BASE_URL);
    this.model = config.model?.trim() || "text-embedding-3-small";
    this.dimensions = config.dimensions ?? 1536;
    this.fetchImpl = fetchImpl;
  }

  async embed(text: string): Promise<number[]> {
    const response = await this.fetchImpl(
      new URL("embeddings", this.baseUrl).toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
          ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        }),
      },
    );

    if (!response.ok) {
      const body = await safeResponseText(response);
      throw new Error(
        `Embedding request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
      );
    }

    const json = (await response.json()) as EmbeddingResponse;
    const embedding = json.data?.[0]?.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error(
        "Embedding API returned empty or missing embedding vector.",
      );
    }
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.fetchImpl(
      new URL("embeddings", this.baseUrl).toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          ...(this.dimensions ? { dimensions: this.dimensions } : {}),
        }),
      },
    );

    if (!response.ok) {
      const body = await safeResponseText(response);
      throw new Error(
        `Batch embedding request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
      );
    }

    const json = (await response.json()) as EmbeddingResponse;
    const data = json.data ?? [];
    return data.map((item) => item.embedding ?? []);
  }
}

/**
 * Create an embedding provider from environment variables.
 * Returns undefined if no API key is configured — callers should
 * fall back to keyword/hash embedding in that case.
 */
export function createDefaultEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): OpenAICompatibleEmbeddingProvider | undefined {
  const apiKey = env[LLM_API_KEY_ENV] ?? env[DEEPSEEK_API_KEY_ENV];
  if (!apiKey) return undefined;
  try {
    return new OpenAICompatibleEmbeddingProvider(
      {
        apiKey,
        baseUrl: env["SUNPILOT_LLM_BASE_URL"] ?? DEFAULT_LLM_BASE_URL,
        model: env["SUNPILOT_EMBEDDING_MODEL"] ?? "text-embedding-3-small",
      },
      fetchImpl,
    );
  } catch {
    return undefined;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return DEFAULT_LLM_BASE_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
