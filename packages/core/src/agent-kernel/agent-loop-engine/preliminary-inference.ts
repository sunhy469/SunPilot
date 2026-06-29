import type { AgentLoopInput, PreliminaryInferenceResult } from "../loop-types.js";
import type { AgentLoopEngineDeps } from "../agent-loop-engine.js";
import type { IAssistantMessageStream } from "../loop-types.js";

/** Best-effort lightweight routing inference, isolated from the formal response stream. */
export class PreliminaryInferenceService {
  constructor(private readonly deps: AgentLoopEngineDeps) {}

  /**
   * §ReAct: Run a lightweight LLM pre-inference using only the user
   * message + system prompt (no full context). The model outputs:
   *   1. A brief natural-language thinking message (written to the stream)
   *   2. A JSON routing block with intent + tool hints
   *
   * The thinking text replaces the old template preface ("我先调用xxx"),
   * giving users a natural-language explanation of what the agent is about
   * to do.
   *
   * When a stream is provided, the thinking text is written as a "progress"
   * text part so the frontend renders it in the thinking section.
   *
   * Best-effort: failure does not affect the main flow.
   */
  async run(
    input: AgentLoopInput,
    signal: AbortSignal,
    stream?: IAssistantMessageStream,
  ): Promise<PreliminaryInferenceResult | undefined> {
    const t0 = Date.now();
    try {
      const messages = [
        { role: "system" as const, content: this.buildPreliminarySystemPrompt() },
        { role: "user" as const, content: input.message },
      ];

      let fullText = "";
      const modelRouter = this.deps.modelRouter!;
      for await (const chunk of modelRouter.streamChat("intent_classification", { messages }, signal)) {
        if (signal.aborted) break;
        fullText += chunk.delta;
      }

      // §ReAct: Split the response into thinking text + JSON routing block.
      // The model outputs: [optional thinking text] {JSON}
      const { thinkingText, jsonText } = this.splitThinkingAndJson(fullText);
      const parsed = this.parsePreInferenceResponse(jsonText);
      const toolHints = parsed.toolHints;
      const intentType = parsed.intentType;
      const intentConfidence = parsed.intentConfidence;

      // §ReAct: Write thinking text to the stream as a "progress" text part.
      // This replaces the old template preface with natural LLM output.
      if (stream && thinkingText && thinkingText.trim().length > 0) {
        const prefacePart = stream.startTextPart("progress");
        stream.appendText(prefacePart.id, thinkingText.trim());
        stream.completeTextPart(prefacePart.id);
      }

      // Record trace metadata for observability
      if (this.deps.traceManager) {
        const preInferenceMs = Date.now() - t0;
        const { endSpan } = this.deps.traceManager.startSpan(input.runId, "pre_inference_await");
        endSpan("preliminary_inference_completed", {
          modelCalls: 1,
          latencyMs: preInferenceMs,
          preInferenceIntentType: intentType,
          preInferenceConfidence: intentConfidence,
          preInferenceLatencyMs: preInferenceMs,
        });
      }

      return { text: fullText, thinkingText, toolHints, intentType, intentConfidence };
    } catch (error) {
      // Pre-inference is best-effort — never block the main flow.
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

  /** §ReAct: Split the model response into thinking text (before the JSON
   *  block) and the JSON routing block. Strips prompt formatting labels
   *  ("PART 1", "Thinking:", "PART 2", "Routing JSON:") that the model
   *  may echo from the system prompt. */
  private splitThinkingAndJson(fullText: string): { thinkingText?: string; jsonText: string } {
    const jsonStart = fullText.indexOf("{");
    if (jsonStart <= 0) {
      return { jsonText: fullText };
    }
    let thinkingText = fullText.slice(0, jsonStart).trim();
    // Strip prompt labels that the model may have echoed
    thinkingText = thinkingText
      .replace(/^PART\s*1\s*[-:.]?\s*/i, "")
      .replace(/^Thinking\s*[:：]\s*/i, "")
      .replace(/PART\s*2\s*[-:.]?\s*Routing\s*JSON\s*[:：]?\s*/gi, "")
      .replace(/Routing\s*JSON\s*[:：]\s*/gi, "")
      .trim();
    const jsonText = fullText.slice(jsonStart).trim();
    return { thinkingText: thinkingText || undefined, jsonText };
  }

  /** Build a minimal system prompt for the pre-inference LLM call.
   *  §ReAct: The model outputs a brief natural-language thinking message
   *  first, then a JSON routing block. The thinking text is user-visible
   *  and replaces the old template preface. */
  private buildPreliminarySystemPrompt(): string {
    return `You are SunPilot's internal router. Analyze the user message and respond with:
1. ONE brief Chinese sentence explaining what you're about to do (e.g. "我先去1688搜索这件衬衫的同款货源")
2. A JSON routing object: {"intentCategory": "product_search"|"image_analysis"|"casual_chat"|"data_analysis"|"web_search"|"file_operation"|"diagnostics"|"automation"|"artifact_generation"|"unknown", "toolHints": [{"category": "product sourcing|image analysis|camera|data|web|diagnostics|automation|artifact", "confidence": 0.0-1.0}], "isSimpleChat": true|false}

Rules:
- Output the Chinese sentence first, then the JSON on its own line
- Do NOT wrap JSON in markdown code fences
- Do NOT add labels like "PART 1" or "Thinking:" — just output the sentence directly`;
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
