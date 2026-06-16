/**
 * Deterministic Fake LLM Provider for Golden Task evaluation.
 *
 * Returns pre-scripted responses based on purpose instead of calling
 * a real LLM. This makes golden task evaluation fast, deterministic,
 * and free of API costs.
 *
 * Each Golden Task can register its own expected responses via
 * `registerResponse()`. Unregistered purposes fall back to sensible
 * defaults that won't break the agent loop.
 */

import type {
  ChatCompletionDelta,
  ChatCompletionRequest,
  LlmProvider,
  ModelPurpose,
} from "@sunpilot/core";

// ── Response Script ────────────────────────────────────────────────────────

export interface PurposeResponse {
  /** The text content to stream back. */
  content: string;
  /** Optional delay between chunks (ms). 0 = no delay. */
  chunkDelayMs?: number;
  /** Whether to simulate an error. */
  error?: string;
}

/**
 * FakeLlmProvider — deterministic LLM for eval/golden-task testing.
 *
 * Usage:
 *   const fake = new FakeLlmProvider("fake-eval");
 *   fake.register("intent_classification", { content: '{"type":"use_skill"}' });
 *   fake.register("tool_argument_generation", { content: '{"query":"test"}' });
 *   // ... use as LlmProvider in createAgentLoopService
 */
export class FakeLlmProvider implements LlmProvider {
  readonly id: string;
  readonly model = "fake-eval-model";

  private readonly scripts = new Map<string, PurposeResponse>();

  constructor(id: string = "fake-eval") {
    this.id = id;
  }

  /** Register a scripted response for a specific purpose. */
  register(purpose: ModelPurpose | string, response: PurposeResponse): void {
    this.scripts.set(purpose, response);
  }

  /** Clear all registered scripts. */
  clear(): void {
    this.scripts.clear();
  }

  async *streamChat(
    request: ChatCompletionRequest,
  ): AsyncIterable<ChatCompletionDelta> {
    const signal = request.signal;

    // Determine purpose from the last user message or system prompt
    const purpose = inferPurposeFromMessages(request.messages);
    const script = this.scripts.get(purpose);

    if (script?.error) {
      throw new Error(script.error);
    }

    const content = script?.content ?? getDefaultResponse(purpose, request);
    const chunkDelayMs = script?.chunkDelayMs ?? 0;

    // Stream content in small chunks to simulate real LLM streaming
    const chunks = splitIntoChunks(content, 20);
    for (const chunk of chunks) {
      if (signal?.aborted) throw new Error("Aborted");

      if (chunkDelayMs > 0) {
        await delay(chunkDelayMs);
      }

      yield { delta: chunk, raw: { content: chunk } };
    }
  }
}

// ── Purpose Inference ──────────────────────────────────────────────────────

/**
 * Heuristically infer the purpose from the messages.
 * In real code this is set by the ModelRouter, but the FakeLlmProvider
 * receives raw messages and needs to figure out what's being asked.
 */
function inferPurposeFromMessages(
  messages: Array<{ role: string; content: string }>,
): string {
  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const combined = `${systemMsg}\n${lastUser}`;

  if (combined.includes("intent") || combined.includes("classify")) return "intent_classification";
  if (combined.includes("argument") || combined.includes("parameter") || combined.includes("tool_call")) return "tool_argument_generation";
  if (combined.includes("reflect") || combined.includes("analyze") || combined.includes("result")) return "reflection";
  if (combined.includes("respond") || combined.includes("answer") || combined.includes("compose")) return "response_composition";
  if (combined.includes("summar") || combined.includes("compress")) return "summary_compression";
  if (combined.includes("plan") || combined.includes("replan")) return "planning";
  if (combined.includes("clarif")) return "clarification";

  // Default: look at the last user message content for hints
  const searchTerms = ["搜索", "search", "find", "查找", "get", "fetch"];
  if (searchTerms.some((t) => lastUser.includes(t))) return "tool_argument_generation";

  return "response_composition";
}

// ── Default Responses ──────────────────────────────────────────────────────

function getDefaultResponse(
  purpose: string,
  _request: ChatCompletionRequest,
): string {
  switch (purpose) {
    case "intent_classification":
      return JSON.stringify({
        intent: "use_skill",
        confidence: 0.9,
        candidateSkills: [],
      });

    case "tool_argument_generation":
      return JSON.stringify({ query: "default" });

    case "planning":
      return "Create a plan with tool execution steps.";

    case "replanning":
      return "Adjust plan based on new information.";

    case "reflection":
      return JSON.stringify({
        goalAchieved: true,
        nextAction: "respond",
        confidence: 0.9,
        summary: "Task completed successfully.",
      });

    case "response_composition":
      return "任务已完成。";

    case "summary_compression":
      return "Conversation summary placeholder.";

    case "clarification":
      return "请提供更多信息以继续。";

    default:
      return "OK";
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function splitIntoChunks(text: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks.length === 0 ? [" "] : chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
