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

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
