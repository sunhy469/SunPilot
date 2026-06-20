import { DEFAULT_LLM_BASE_URL } from "./llm.config.js";

export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return DEFAULT_LLM_BASE_URL;
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

export async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
