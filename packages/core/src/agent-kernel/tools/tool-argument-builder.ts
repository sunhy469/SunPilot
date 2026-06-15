import type { LlmProvider } from "../../llm/llm.provider.js";
import type {
  AgentContext,
  AgentObservation,
  AgentPlan,
  AttachmentRef,
  RoutedIntent,
} from "../loop-types.js";
import type { SkillSummary } from "./tool-types.js";

// ── Types ────────────────────────────────────────────────────────────────

export interface ToolArgumentBuilderInput {
  context: AgentContext;
  intent: RoutedIntent;
  plan?: AgentPlan;
  skill: SkillSummary;
  /** Capability input schema (JSON Schema or Zod schema object). */
  schema?: Record<string, unknown>;
  /** Previous observation for multi-turn tool chains (e.g. search → detail). */
  previousObservation?: AgentObservation;
}

export interface ToolArgumentBuilderResult {
  arguments: Record<string, unknown>;
  confidence: number;
  /** Required fields that could not be filled — trigger ask_clarification. */
  missing: string[];
  /** Provenance tracking for each argument. */
  sources: Array<{
    arg: string;
    source: "message" | "attachment" | "memory" | "tool_result" | "plan" | "llm" | "heuristic";
    ref?: string;
  }>;
}

export interface ToolArgumentRepairInput {
  skillId: string;
  name: string;
  currentArgs: Record<string, unknown>;
  schema?: Record<string, unknown>;
  validationErrors: string[];
}

export interface ToolArgumentBuilder {
  build(
    input: ToolArgumentBuilderInput,
    signal: AbortSignal,
  ): Promise<ToolArgumentBuilderResult>;

  /**
   * Repair arguments that failed schema validation.
   * Called by the ExecutionOrchestrator when validateArguments() fails.
   * Uses LLM (when available) to fix malformed/incorrect arguments,
   * falling back to heuristic correction for common issues
   * (type coercion, enum matching, etc.).
   */
  repair(
    input: ToolArgumentRepairInput,
    signal: AbortSignal,
  ): Promise<{ arguments: Record<string, unknown> }>;
}

// ── Implementation ───────────────────────────────────────────────────────

export interface DefaultToolArgumentBuilderDeps {
  /** Optional LLM for structured argument generation when heuristics are insufficient. */
  llm?: LlmProvider;
}

/**
 * DefaultToolArgumentBuilder — schema-aware tool argument construction.
 *
 * Priority strategy (highest to lowest):
 *   1. Plan step input (explicitly provided arguments)
 *   2. Capability schema required fields
 *   3. Current message: URLs, numbers, product IDs, filenames
 *   4. Current attachments and historical attachments
 *   5. Previous tool structured result (multi-turn chains)
 *   6. LLM structured output (when heuristics insufficient)
 *   7. Missing required fields → ask_clarification
 *
 * Before execution, arguments MUST be validated against the capability schema.
 * Missing required fields trigger ask_clarification rather than blind execution.
 */
export class DefaultToolArgumentBuilder implements ToolArgumentBuilder {
  constructor(private readonly deps: DefaultToolArgumentBuilderDeps = {}) {}

  async build(
    input: ToolArgumentBuilderInput,
    signal: AbortSignal,
  ): Promise<ToolArgumentBuilderResult> {
    // ... (existing build implementation)
    const args: Record<string, unknown> = {};
    const sources: ToolArgumentBuilderResult["sources"] = [];
    const missing: string[] = [];

    // ── Priority 1: Plan step input ──────────────────────────────────────
    if (input.plan) {
      const planStep = input.plan.steps.find(
        (s) => s.type === "tool" && s.skillId === input.skill.id,
      );
      if (planStep?.input && Object.keys(planStep.input).length > 0) {
        Object.assign(args, planStep.input);
        for (const key of Object.keys(planStep.input)) {
          sources.push({ arg: key, source: "plan", ref: planStep.id });
        }
        return {
          arguments: args,
          confidence: 1.0,
          missing: this.findMissingRequired(args, input.schema),
          sources,
        };
      }
    }

    const message = input.context.currentMessage.content.trim();
    const attachments = input.context.currentMessage.attachments ?? [];

    // Collect historical attachments from context messages
    const historicalAttachments: AttachmentRef[] = [];
    for (const msg of input.context.messages) {
      const msgAttachments = msg.metadata?.attachments as
        | AttachmentRef[]
        | undefined;
      if (msgAttachments && msgAttachments.length > 0) {
        historicalAttachments.push(...msgAttachments);
      }
    }
    const allAttachments = [...attachments, ...historicalAttachments];

    // ── Priority 2: Schema required fields ───────────────────────────────
    const requiredFields = this.extractRequiredFields(input.schema);

    // ── Priority 3: Extract from message ──────────────────────────────────
    // URLs
    const urls = extractUrls(message);
    if (urls.length > 0 && requiredFields.some((f) => f === "url" || f === "urls")) {
      args.urls = urls;
      args.url = urls[0];
      sources.push({ arg: "url", source: "message" });
      sources.push({ arg: "urls", source: "message" });
    }

    // Query (always include)
    if (message.length > 0 && requiredFields.some((f) => f === "query" || f === "prompt")) {
      args.query = message;
      sources.push({ arg: "query", source: "message" });
    }

    // ── Priority 4: Attachments ──────────────────────────────────────────
    if (allAttachments.length > 0) {
      const imageAttachment = allAttachments.find(
        (a) =>
          Boolean(a.url) &&
          (a.type.startsWith("image/") ||
            /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(a.url ?? "")),
      );

      args.attachments = allAttachments.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        url: a.url,
        storageKey: a.storageKey,
        provider: a.provider,
      }));
      sources.push({ arg: "attachments", source: "attachment" });

      if (imageAttachment?.url) {
        args.imageUrl = imageAttachment.url;
        args.image_url = imageAttachment.url;
        sources.push({ arg: "imageUrl", source: "attachment", ref: imageAttachment.id });
      }
    }

    // ── Priority 5: Previous tool structured result ──────────────────────
    if (input.previousObservation) {
      const prevToolCall = input.previousObservation.toolCalls[0];
      if (prevToolCall) {
        // Pass the previous tool call ID for tool chain scenarios
        args.previousToolCallId = prevToolCall.id;
        sources.push({
          arg: "previousToolCallId",
          source: "tool_result",
          ref: prevToolCall.id,
        });
      }
    }

    // ── Priority 6: LLM structured output for remaining fields ───────────
    const remainingMissing = this.findMissingRequired(args, input.schema);
    if (remainingMissing.length > 0 && this.deps.llm && !signal.aborted) {
      try {
        const llmArgs = await this.generateWithLlm(
          input,
          args,
          remainingMissing,
        );
        Object.assign(args, llmArgs);
        for (const key of Object.keys(llmArgs)) {
          sources.push({ arg: key, source: "llm" });
        }
      } catch {
        // LLM unavailable — continue with what we have
      }
    }

    // ── Priority 7: Determine final missing fields ───────────────────────
    const finalMissing = this.findMissingRequired(args, input.schema);
    for (const field of finalMissing) {
      missing.push(field);
    }

    // Calculate confidence based on how many required fields are filled
    const totalRequired = requiredFields.length;
    const filledRequired = totalRequired - missing.length;
    const confidence =
      totalRequired === 0 ? 0.9 : filledRequired / totalRequired;

    return {
      arguments: args,
      confidence: Math.max(0.1, confidence),
      missing,
      sources,
    };
  }

  /**
   * Repair arguments that failed schema validation.
   *
   * Two-tier strategy:
   *   1. Heuristic fix: type coercion, enum fuzzy matching, trimming
   *   2. LLM regeneration: for complex fixes when heuristics insufficient
   */
  async repair(
    input: ToolArgumentRepairInput,
    signal: AbortSignal,
  ): Promise<{ arguments: Record<string, unknown> }> {
    const repaired: Record<string, unknown> = { ...input.currentArgs };

    // ── Tier 1: Heuristic fixes ──────────────────────────────────────────
    if (input.schema) {
      const properties =
        (input.schema.properties as Record<string, Record<string, unknown>>) ?? {};

      for (const error of input.validationErrors) {
        // "Missing required field: X" → try to fill from defaults
        const missingMatch = error.match(/^Missing required field: (.+)$/);
        if (missingMatch?.[1]) {
          const field = missingMatch[1];
          const propSchema = properties[field];
          if (propSchema?.default !== undefined) {
            repaired[field] = propSchema.default;
          }
          continue;
        }

        // "Field \"X\" must be a string" → coerce to string
        const typeMatch = error.match(/^Field "(.+)" must be a string$/);
        if (typeMatch?.[1]) {
          const field = typeMatch[1];
          const value = repaired[field];
          if (value !== undefined && value !== null && typeof value !== "string") {
            repaired[field] = String(value);
          }
          continue;
        }

        // "Field \"X\" must be a number" → coerce to number
        const numMatch = error.match(/^Field "(.+)" must be a number$/);
        if (numMatch?.[1]) {
          const field = numMatch[1];
          const value = repaired[field];
          if (typeof value === "string") {
            const parsed = Number(value);
            if (!isNaN(parsed)) {
              repaired[field] = parsed;
            }
          }
          continue;
        }

        // "Field \"X\" must be an array" → wrap in array
        const arrMatch = error.match(/^Field "(.+)" must be an array$/);
        if (arrMatch?.[1]) {
          const field = arrMatch[1];
          const value = repaired[field];
          if (value !== undefined && value !== null && !Array.isArray(value)) {
            repaired[field] = [value];
          }
          continue;
        }

        // "Field \"X\" must be one of: A, B, C" → fuzzy match enum
        const enumMatch = error.match(/^Field "(.+)" must be one of: (.+)$/);
        if (enumMatch?.[1] && enumMatch[2]) {
          const field = enumMatch[1];
          const allowed = enumMatch[2].split(", ").map((s) => s.trim());
          const value = repaired[field];
          if (typeof value === "string") {
            const lower = value.toLowerCase();
            const bestMatch = allowed.find(
              (a) => a.toLowerCase() === lower || a.toLowerCase().includes(lower) || lower.includes(a.toLowerCase()),
            );
            if (bestMatch) {
              repaired[field] = bestMatch;
            }
          }
          continue;
        }
      }
    }

    // ── Tier 2: LLM regeneration for remaining unfixable errors ─────────
    if (this.deps.llm && !signal.aborted) {
      try {
        const llmRepaired = await this.repairWithLlm(input, signal);
        Object.assign(repaired, llmRepaired);
      } catch {
        // LLM repair failed — return what we have from heuristics
      }
    }

    return { arguments: repaired };
  }

  /**
   * Extract required field names from a JSON Schema / capability input schema.
   */
  private extractRequiredFields(schema?: Record<string, unknown>): string[] {
    if (!schema) return [];
    const required = schema.required;
    if (Array.isArray(required)) {
      return required.filter((f): f is string => typeof f === "string");
    }
    // If no explicit 'required', extract top-level property names
    const properties = schema.properties;
    if (properties && typeof properties === "object") {
      return Object.keys(properties);
    }
    return [];
  }

  /**
   * Find required fields that are missing or empty in the current arguments.
   */
  private findMissingRequired(
    args: Record<string, unknown>,
    schema?: Record<string, unknown>,
  ): string[] {
    const required = this.extractRequiredFields(schema);
    return required.filter((field) => {
      const value = args[field];
      return value === undefined || value === null || value === "";
    });
  }

  /**
   * Use LLM structured output to fill remaining required fields.
   * Only called when heuristics cannot resolve all required parameters.
   */
  private async generateWithLlm(
    input: ToolArgumentBuilderInput,
    currentArgs: Record<string, unknown>,
    missingFields: string[],
  ): Promise<Record<string, unknown>> {
    if (!this.deps.llm) return {};

    const schemaDesc = input.schema
      ? `Schema: ${JSON.stringify(input.schema)}`
      : "No schema available.";

    const contextDesc = [
      `User message: "${input.context.currentMessage.content}"`,
      `Skill: ${input.skill.name} (${input.skill.id})`,
      `Description: ${input.skill.description}`,
      `Current arguments: ${JSON.stringify(currentArgs)}`,
      `Missing required fields: ${missingFields.join(", ")}`,
      schemaDesc,
    ].join("\n");

    const prompt = `Fill in the missing tool arguments based on the user's request.

${contextDesc}

Respond with ONLY a JSON object containing the missing field values. Use null for fields you cannot determine. Do NOT include any explanatory text.`;

    const messages = [{ role: "user" as const, content: prompt }];
    let response = "";

    for await (const chunk of this.deps.llm.streamChat({ messages })) {
      response += chunk.delta;
    }

    try {
      // Extract JSON from response (may be wrapped in markdown code block)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // Only include fields that were actually missing
          const result: Record<string, unknown> = {};
          for (const field of missingFields) {
            if (field in parsed && parsed[field] !== null) {
              result[field] = parsed[field];
            }
          }
          return result;
        }
      }
    } catch {
      // Parse failure — return empty
    }

    return {};
  }

  /**
   * Use LLM to repair arguments that failed schema validation.
   * Provides the full validation error context so the LLM can fix the issues.
   */
  private async repairWithLlm(
    input: ToolArgumentRepairInput,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (!this.deps.llm) return {};

    const schemaDesc = input.schema
      ? `Schema: ${JSON.stringify(input.schema)}`
      : "No schema available.";

    const prompt = `Fix the following tool argument validation errors.

Tool: ${input.name} (${input.skillId})
Current arguments: ${JSON.stringify(input.currentArgs)}
Validation errors:
${input.validationErrors.map((e) => `  - ${e}`).join("\n")}
${schemaDesc}

Respond with ONLY a JSON object containing the CORRECTED field values. Only include fields mentioned in the validation errors. Use the correct types and enum values. Do NOT include any explanatory text.`;

    const messages = [{ role: "user" as const, content: prompt }];
    let response = "";

    for await (const chunk of this.deps.llm.streamChat({ messages })) {
      response += chunk.delta;
    }

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Parse failure — return empty
    }

    return {};
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractUrls(text: string): string[] {
  return Array.from(
    text.matchAll(/https?:\/\/[^\s)）"'<>]+/gi),
    (match) => match[0],
  );
}
