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

export interface ChatCompletionDelta {
  delta: string;
  raw: unknown;
}

export interface LlmProvider {
  id: string;
  model: string;
  streamChat(request: ChatCompletionRequest): AsyncIterable<ChatCompletionDelta>;
}

export interface OpenAICompatibleChatProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
