export const DEFAULT_LLM_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_LLM_MODEL = "deepseek-v4-flash";
export const LLM_BASE_URL_ENV = "SUNPILOT_LLM_BASE_URL";
export const LLM_MODEL_ENV = "SUNPILOT_LLM_MODEL";
export const LLM_API_KEY_ENV = "SUNPILOT_LLM_API_KEY";
export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  name?: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  id?: string;
  model: string;
  message: ChatMessage;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  raw: unknown;
}

export interface LlmProvider {
  id: string;
  model: string;
  chat(request: ChatCompletionRequest): Promise<ChatCompletionResult>;
}

export interface OpenAICompatibleChatProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      name?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAICompatibleChatProvider implements LlmProvider {
  id = "llm.openai-compatible";
  model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: OpenAICompatibleChatProviderConfig, fetchImpl: FetchLike = fetch) {
    if (!config.apiKey.trim()) {
      throw new Error(`${LLM_API_KEY_ENV} is required.`);
    }
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_LLM_BASE_URL);
    this.model = config.model?.trim() || DEFAULT_LLM_MODEL;
    this.fetchImpl = fetchImpl;
  }

  async chat(request: ChatCompletionRequest): Promise<ChatCompletionResult> {
    if (request.messages.length === 0) {
      throw new Error("At least one chat message is required.");
    }

    const response = await this.fetchImpl(new URL("/chat/completions", this.baseUrl).toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        stream: false
      }),
      signal: request.signal
    });

    if (!response.ok) {
      const body = await safeResponseText(response);
      throw new Error(`LLM request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`);
    }

    const raw: unknown = await response.json();
    const data = raw as OpenAIChatResponse;
    const firstMessage = data.choices?.[0]?.message;
    if (!firstMessage) {
      throw new Error("LLM response did not include an assistant message.");
    }
    const content = firstMessage.content;
    if (typeof content !== "string") {
      throw new Error("LLM response did not include assistant content.");
    }

    return {
      id: data.id,
      model: data.model ?? this.model,
      message: {
        role: normalizeRole(firstMessage.role),
        content,
        name: firstMessage.name
      },
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens
          }
        : undefined,
      raw
    };
  }
}

export function createDefaultLlmProvider(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): OpenAICompatibleChatProvider {
  const apiKey = env[LLM_API_KEY_ENV] ?? env[DEEPSEEK_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(`${LLM_API_KEY_ENV} or ${DEEPSEEK_API_KEY_ENV} is required.`);
  }
  return new OpenAICompatibleChatProvider(
    {
      apiKey,
      baseUrl: env[LLM_BASE_URL_ENV] ?? DEFAULT_LLM_BASE_URL,
      model: env[LLM_MODEL_ENV] ?? DEFAULT_LLM_MODEL
    },
    fetchImpl
  );
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return DEFAULT_LLM_BASE_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function normalizeRole(role: string | undefined): ChatRole {
  if (role === "system" || role === "user" || role === "assistant" || role === "tool") return role;
  return "assistant";
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
