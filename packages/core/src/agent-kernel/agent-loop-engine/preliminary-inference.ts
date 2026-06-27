import type { AgentLoopInput, PreliminaryInferenceResult } from "../loop-types.js";
import type { AgentLoopEngineDeps } from "../agent-loop-engine.js";

/** Best-effort lightweight routing inference, isolated from the formal response stream. */
export class PreliminaryInferenceService {
  constructor(private readonly deps: AgentLoopEngineDeps) {}

  /**
   * §Parallel optimization: Run a lightweight LLM pre-inference using
   * only the user message + system prompt (no context). This produces
   * tool-matching hints that can accelerate downstream routing.
   *
   * IMPORTANT: This method does NOT write to the formal
   * AssistantMessageStream. Pre-inference text is collected internally
   * and only used for tool hint extraction. The formal stream is created
   * later in runContentBlockLoop(), ensuring clean message persistence
   * and avoiding history pollution.
   *
   * Best-effort: failure does not affect the main flow.
   */
  async run(
    input: AgentLoopInput,
    signal: AbortSignal,
  ): Promise<PreliminaryInferenceResult | undefined> {
    const t0 = Date.now();
    try {
      const messages = [
        { role: "system" as const, content: this.buildPreliminarySystemPrompt() },
        { role: "user" as const, content: input.message },
      ];

      // Collect pre-inference text without writing to the formal stream.
      // The text is only used for tool hint extraction.
      let fullText = "";
      const modelRouter = this.deps.modelRouter!;
      for await (const chunk of modelRouter.streamChat("intent_classification", { messages }, signal)) {
        if (signal.aborted) break;
        fullText += chunk.delta;
      }

      // §P3 opt: Extract full intent + tool hints from the pre-inference JSON.
      // When intent confidence ≥ 0.7, the main IntentRouter can skip its
      // own Layer 2 LLM call, saving ~200-800ms.
      const parsed = this.parsePreInferenceResponse(fullText);
      const toolHints = parsed.toolHints;
      const intentType = parsed.intentType;
      const intentConfidence = parsed.intentConfidence;

      // Record trace metadata for observability
      if (this.deps.traceManager) {
        const preInferenceMs = Date.now() - t0;
        const { endSpan } = this.deps.traceManager.startSpan(input.runId, "pre_inference_await");
        endSpan("preliminary_inference_completed", {
          modelCalls: 1,
          latencyMs: preInferenceMs,
          // §P3: Track pre-inference intent quality for observability
          preInferenceIntentType: intentType,
          preInferenceConfidence: intentConfidence,
          preInferenceLatencyMs: preInferenceMs,
        });
      }

      return { text: fullText, toolHints, intentType, intentConfidence };
    } catch (error) {
      // Pre-inference is best-effort — never block the main flow.
      // Record failure in trace for observability.
      if (this.deps.traceManager) {
        const { endSpan } = this.deps.traceManager.startSpan(input.runId, "pre_inference_await");
        endSpan("preliminary_inference_failed", {
          latencyMs: Date.now() - t0,
          preInferenceError: error instanceof Error ? error.message : String(error),
        });
      }
      return undefined;
    }
  }

  /** Build a minimal system prompt for the pre-inference LLM call.
   *  §P2: Changed from natural language acknowledgment to structured JSON
   *  hint — avoids generating useless text and produces parseable tool hints.
   *  §3.3: Expanded categories to cover diagnostics, automation, and
   *  artifact_generation so more queries can skip Layer 2 LLM routing. */
  private buildPreliminarySystemPrompt(): string {
    return `You are SunPilot's internal router. Analyze the user message and respond with ONLY a JSON object containing routing hints. Do NOT produce natural language.

Output format:
{"intentCategory": "product_search"|"image_analysis"|"casual_chat"|"data_analysis"|"web_search"|"file_operation"|"diagnostics"|"automation"|"artifact_generation"|"unknown", "toolHints": [{"category": "product sourcing|image analysis|camera|data|web|diagnostics|automation|artifact", "confidence": 0.0-1.0}], "isSimpleChat": true|false}

Rules:
- "intentCategory": best-guess category of the user's request
- "toolHints": up to 3 relevant tool categories with confidence scores
- "isSimpleChat": true if this is clearly just conversation (greetings, thanks, small talk)

Category guidance:
- "diagnostics": troubleshooting, error analysis, system inspection
- "automation": multi-step workflow execution, batch operations
- "artifact_generation": creating documents, reports, code files, images

Keep your response to the JSON object ONLY — no preamble, no explanation.`;
  }

  /** §P3 opt: Parse the pre-inference JSON response, extracting both intent
   *  classification and tool-matching hints. The intent result is used to
   *  skip the main IntentRouter's Layer 2 LLM call when confidence ≥ 0.7.
   *  Falls back gracefully if JSON parsing fails. */
  private parsePreInferenceResponse(
    preText: string,
  ): {
    intentType?: string;
    intentConfidence?: number;
    toolHints?: PreliminaryInferenceResult["toolHints"];
  } {
    try {
      // Try to extract JSON from the response (may have markdown wrapping)
      const jsonMatch = preText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return {};
      const parsed = JSON.parse(jsonMatch[0]) as {
        intentCategory?: string;
        toolHints?: Array<{ category: string; confidence: number }>;
        isSimpleChat?: boolean;
      };

      // §P3: Map pre-inference intentCategory to AgentLoop intent type.
      // The pre-inference prompt categories are broader than the intent
      // router's categories — we need to bridge them.
      // §3.3: Added diagnostics, automation, artifact_generation mappings.
      const intentTypeMap: Record<string, string> = {
        "casual_chat": "casual_chat",
        "product_search": "use_skill",
        "image_analysis": "use_skill",
        "data_analysis": "question_answering",
        "web_search": "question_answering",
        "file_operation": "file_operation",
        "diagnostics": "diagnostics",
        "automation": "automation_execution",
        "artifact_generation": "artifact_generation",
        "unknown": "unknown",
      };
      const rawCategory = parsed.intentCategory ?? "unknown";
      const intentType = intentTypeMap[rawCategory] ?? "unknown";
      // Confidence: 0.8 for pre-inference since it's a lightweight call.
      // Bump to 0.9 for casual_chat (very reliable) and 0.7 for unknown (less reliable).
      let intentConfidence: number;
      if (rawCategory === "casual_chat") intentConfidence = 0.9;
      else if (rawCategory === "unknown") intentConfidence = 0.6; // §3.1: < 0.7 to trigger Layer 2 fallback
      else intentConfidence = 0.8;

      // Tool hints (existing logic)
      // §3.3: Added diagnostics, automation, artifact categories.
      const categoryToSkillMap: Record<string, string[]> = {
        "product sourcing": ["jaderoad:product.source.search1688"],
        "image analysis": ["image.analyze"],
        "data analysis": ["data.analyze"],
        "web search": ["web.search"],
        "file operation": ["filesystem.read", "filesystem.write"],
        "diagnostics": ["shell.exec", "filesystem.read"],
        "automation": ["shell.exec", "filesystem.write"],
        "artifact": ["filesystem.write"],
      };
      const hints = (parsed.toolHints ?? [])
        .filter((h: { confidence: number }) => h.confidence >= 0.5)
        .flatMap((h: { category: string; confidence: number }) => {
          const skillIds = categoryToSkillMap[h.category.toLowerCase()] ?? [];
          return skillIds.map((skillId) => ({
            skillId,
            reason: `Pre-inference JSON hint: ${h.category} (confidence: ${h.confidence})`,
          }));
        })
        .slice(0, 5);

      return {
        intentType,
        intentConfidence,
        toolHints: hints.length > 0 ? hints : undefined,
      };
    } catch {
      return {};
    }
  }
}
