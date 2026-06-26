import {
  DEEPSEEK_API_KEY_ENV,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  LLM_API_KEY_ENV,
  LLM_BASE_URL_ENV,
  LLM_MODEL_ENV,
} from "./llm.config.js";
import { normalizeBaseUrl, safeResponseText } from "./llm-utils.js";
import type {
  ChatCompletionDelta,
  ChatCompletionRequest,
  FetchLike,
  LlmProvider,
  OpenAICompatibleChatProviderConfig,
  ToolCallDelta,
} from "./llm.types.js";

interface OpenAIChatStreamChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      name?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
}

/**
 * OpenAI 兼容 Chat Provider — 通过 OpenAI-compatible API 提供 LLM 流式调用。
 *
 * 流式处理链路：
 * 1. POST /chat/completions（stream: true）
 * 2. 读取 Response body 的 ReadableStream
 * 3. 按 SSE (Server-Sent Events) 协议解析：data: {...}\n\n
 * 4. 从 choices[].delta.content 提取增量文本
 * 5. 通过 async generator yield 给上层调用方（ResponseComposer）
 *
 * 支持 OpenAI API 和 DeepSeek API 两种后端（通过 DEEPSEEK_API_KEY_ENV 环境变量切换）。
 */
export class OpenAICompatibleChatProvider implements LlmProvider {
  id: string;
  model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(
    config: OpenAICompatibleChatProviderConfig,
    fetchImpl: FetchLike = fetch,
  ) {
    if (!config.apiKey.trim()) {
      throw new Error(`${LLM_API_KEY_ENV} is required.`);
    }
    this.id = config.id ?? "llm.openai-compatible";
    this.apiKey = config.apiKey;
    this.baseUrl = normalizeBaseUrl(config.baseUrl ?? DEFAULT_LLM_BASE_URL);
    this.model = config.model?.trim() || DEFAULT_LLM_MODEL;
    this.fetchImpl = fetchImpl;
  }

  async *streamChat(
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatCompletionDelta> {
    if (request.messages.length === 0) {
      throw new Error("At least one chat message is required.");
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: true,
    };

    // Native function calling: include tools and tool_choice when provided
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools;
      if (request.tool_choice) {
        body.tool_choice = request.tool_choice;
      }
    }

    // §Perf: Volcengine Ark's doubao-seed models default to reasoning
    // mode, burning hundreds of tokens on internal reasoning before
    // emitting output. For classification/simple tasks this adds
    // 10-40s of wasted TTFT. The caller can opt out via request metadata.
    if (this.baseUrl.includes("volces.com") && !(request.metadata as Record<string, unknown> | undefined)?.allowReasoning) {
      body.thinking = { type: "disabled" };
    }

    const response = await this.fetchImpl(
      new URL("chat/completions", this.baseUrl).toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
    );

    if (!response.ok) {
      const body = await safeResponseText(response);
      throw new Error(
        `LLM request failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
      );
    }

    if (!response.body) {
      throw new Error(
        "LLM streaming response did not include a response body.",
      );
    }

    for await (const data of parseOpenAIStream(response.body)) {
      if (data === "[DONE]") return;
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        continue; // Skip corrupted SSE events
      }
      const chunk = raw as OpenAIChatStreamChunk;
      for (const choice of chunk.choices ?? []) {
        const textDelta = choice.delta?.content;
        const toolCallsDelta = choice.delta?.tool_calls;

        // Build delta: include text if present, tool_calls if present
        const delta: ChatCompletionDelta = {
          delta: typeof textDelta === "string" ? textDelta : "",
          raw,
        };

        if (toolCallsDelta && toolCallsDelta.length > 0) {
          delta.toolCalls = toolCallsDelta.map((tc) => ({
            index: tc.index,
            id: tc.id,
            type: tc.type,
            function: tc.function,
          })) as ToolCallDelta[];
        }

        // Yield if there's text content or tool calls
        if (delta.delta.length > 0 || delta.toolCalls) {
          yield delta;
        }
      }
    }
  }
}

export function createDefaultLlmProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): OpenAICompatibleChatProvider {
  const apiKey = env[LLM_API_KEY_ENV] ?? env[DEEPSEEK_API_KEY_ENV];
  if (!apiKey) {
    throw new Error(
      `${LLM_API_KEY_ENV} or ${DEEPSEEK_API_KEY_ENV} is required.`,
    );
  }
  return new OpenAICompatibleChatProvider(
    {
      apiKey,
      baseUrl: env[LLM_BASE_URL_ENV] ?? DEFAULT_LLM_BASE_URL,
      model: env[LLM_MODEL_ENV] ?? DEFAULT_LLM_MODEL,
    },
    fetchImpl,
  );
}

async function* parseOpenAIStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        for (const data of dataLines(event)) yield data;
      }
    }
    buffer += decoder.decode();
    for (const data of dataLines(buffer)) yield data;
  } finally {
    reader.releaseLock();
  }
}

function dataLines(event: string): string[] {
  return event
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter(Boolean);
}
