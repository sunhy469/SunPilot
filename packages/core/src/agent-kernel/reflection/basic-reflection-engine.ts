import type { LlmProvider } from "../../llm/llm.provider.js";
import type {
  AgentContext,
  AgentObservation,
  AgentPlan,
  AgentReflection,
  AgentTaskState,
  ReflectionEngine,
  RoutedIntent,
} from "../loop-types.js";
import { isRepairableFailure } from "../planning/failure-classification.js";

export interface BasicReflectionEngineDeps {
  /** Optional LLM for semantic goal-achievement judgment (layer 2). */
  llm?: LlmProvider;
}

/**
 * StructuredReflectionEngine — dual-layer reflection for multi-turn agent loops.
 *
 * Layer 1 (Rule-based): Deterministic checks based on tool status and result structure.
 *   - Tool failed with repairable params → continue
 *   - Search returned candidates but no details, user wants specs/shipping → continue
 *   - Search returned empty → ask_user or retry
 *   - Tool returned structured error → ask_user or repair
 *   - All tools completed successfully → check LLM layer
 *
 * Layer 2 (LLM): Semantic goal-achievement judgment.
 *   - Input: user goal, plan, tool structured results
 *   - Output: structured reflection JSON
 *   - Never outputs user-visible text
 *
 * Task state is maintained across iterations to track progress.
 */
export class BasicReflectionEngine implements ReflectionEngine {
  constructor(private readonly deps: BasicReflectionEngineDeps = {}) {}

  async reflect(
    input: {
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      observation: AgentObservation;
      taskState?: AgentTaskState;
    },
    signal: AbortSignal,
  ): Promise<AgentReflection> {
    if (signal.aborted) throw new Error("Reflection aborted");

    const { observation, plan } = input;
    const toolCalls = observation.toolCalls;

    // ── Layer 1: Rule-based checks ─────────────────────────────────────

    // Check for failed tool calls
    const failed = toolCalls.filter((call) => call.status !== "completed");
    if (failed.length > 0) {
      const repairable = failed.some((call) =>
        isRepairableFailure(call.summary),
      );
      return {
        goalAchieved: false,
        confidence: 0.2,
        summary: `Tool execution had ${failed.length} non-completed call(s): ${failed
          .map((call) => `${call.name}: ${call.status} — ${call.summary}`)
          .join(", ")}`,
        nextAction: repairable ? "continue" : "respond",
        missingInfo: repairable
          ? ["Tool parameters may need repair or retry"]
          : undefined,
        stopReason: repairable ? undefined : "tool_failed",
      };
    }

    // All tools completed — check if goal is truly achieved
    const hasSearchResults = toolCalls.some((call) =>
      /search|find|source|query|1688|搜索|货源/i.test(call.name),
    );
    const hasDetailResults = toolCalls.some((call) =>
      /detail|spec|sku|shipping|运费|规格/i.test(call.name),
    );

    // If search was done but no detail, and user likely wants detail
    if (hasSearchResults && !hasDetailResults) {
      const userMessage = input.context.currentMessage.content;
      const needsDetail =
        /规格|运费|sku|详情|detail|spec|shipping/i.test(userMessage) ||
        /规格|运费|sku|详情|detail|spec|shipping/i.test(
          input.intent.reason,
        );

      if (needsDetail) {
        const nextCandidates = toolCalls
          .filter((call) => /search/i.test(call.name))
          .map((call) => ({
            skillId: call.skillId.replace(/search/i, "detail"),
            reason: "Search completed, user needs detail info (specs/shipping/SKU)",
          }));

        return {
          goalAchieved: false,
          confidence: 0.3,
          summary:
            "Search completed but user requested detail information (specs, shipping, SKU) which has not been retrieved.",
          nextAction: "continue",
          missingInfo: ["specs", "shipping", "SKU details"],
          nextToolCandidates: nextCandidates.length > 0 ? nextCandidates : undefined,
        };
      }
    }

    // ── Layer 2: LLM semantic judgment (when available) ─────────────────
    if (this.deps.llm && !signal.aborted) {
      try {
        const llmReflection = await this.reflectWithLlm(input);
        if (llmReflection) return llmReflection;
      } catch {
        // LLM unavailable — fall through to deterministic
      }
    }

    // ── Deterministic fallback ─────────────────────────────────────────
    const plannedSteps = plan?.steps.length ?? 0;
    const completedTools = toolCalls.length;

    // Use taskState to improve goal-completion confidence
    const pendingCount = input.taskState?.pendingSteps.length ?? 0;
    const openQuestionCount = input.taskState?.openQuestions.length ?? 0;
    const gatheredFactCount = Object.keys(input.taskState?.gatheredFacts ?? {}).length;
    const iteration = input.taskState?.iteration ?? 1;

    const goalAchieved =
      pendingCount === 0 && openQuestionCount === 0;
    const confidence = goalAchieved
      ? Math.min(0.95, 0.75 + gatheredFactCount * 0.05 + completedTools * 0.05)
      : Math.max(0.2, 0.6 - pendingCount * 0.15 - openQuestionCount * 0.1);

    return {
      goalAchieved,
      confidence,
      summary:
        completedTools > 0 || gatheredFactCount > 0
          ? `Completed ${completedTools} tool call(s), gathered ${gatheredFactCount} fact(s) across ${iteration} iteration(s). Pending: ${pendingCount} step(s), ${openQuestionCount} open question(s).`
          : "No tool calls were required after reflection.",
      nextAction: goalAchieved ? "respond" : "continue",
      missingInfo: input.taskState?.openQuestions.length
        ? input.taskState.openQuestions
        : undefined,
      stopReason: goalAchieved ? "goal_achieved" : undefined,
    };
  }

  /**
   * Layer 2: Use LLM to judge whether the user's goal has been achieved.
   * Returns null if LLM is unavailable or cannot decide.
   */
  private async reflectWithLlm(input: {
    context: AgentContext;
    intent: RoutedIntent;
    plan?: AgentPlan;
    observation: AgentObservation;
    taskState?: AgentTaskState;
  }): Promise<AgentReflection | null> {
    if (!this.deps.llm) return null;

    const toolSummaries = input.observation.toolCalls
      .map(
        (tc) =>
          `- ${tc.name} (${tc.skillId}): ${tc.status} — ${tc.summary}`,
      )
      .join("\n");

    const planSummary = input.plan
      ? `Plan: ${input.plan.goal}\nSteps: ${input.plan.steps.map((s) => s.description).join("; ")}`
      : "No explicit plan.";

    const taskStateInfo = input.taskState
      ? `\nProgress so far (iteration ${input.taskState.iteration}):
  Completed: ${input.taskState.completedSteps.join(", ") || "none"}
  Pending: ${input.taskState.pendingSteps.join(", ") || "none"}
  Gathered facts: ${Object.entries(input.taskState.gatheredFacts).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ") || "none"}
  Open questions: ${input.taskState.openQuestions.join(", ") || "none"}`
      : "";

    const prompt = `You are a reflection judge for an AI agent. Determine whether the user's goal has been achieved.

User goal: "${input.context.currentMessage.content}"
${planSummary}${taskStateInfo}

Tool results:
${toolSummaries || "No tools were executed."}

Respond with ONLY a JSON object (no other text):
{
  "goalAchieved": true or false,
  "confidence": 0.0 to 1.0,
  "summary": "one sentence describing what was accomplished",
  "nextAction": "respond" | "continue" | "ask_user",
  "missingInfo": ["list", "of", "missing", "info"] or null,
  "stopReason": "goal_achieved" | "needs_user" | "tool_failed" | "no_tool_available" or null
}`;

    const messages = [{ role: "user" as const, content: prompt }];
    let response = "";

    for await (const chunk of this.deps.llm.streamChat({ messages })) {
      response += chunk.delta;
    }

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          goalAchieved: Boolean(parsed.goalAchieved),
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
          summary: typeof parsed.summary === "string" ? parsed.summary : "",
          nextAction: ["respond", "continue", "ask_user"].includes(parsed.nextAction)
            ? (parsed.nextAction as "respond" | "continue" | "ask_user")
            : "respond",
          missingInfo: Array.isArray(parsed.missingInfo)
            ? parsed.missingInfo
            : undefined,
          stopReason: parsed.stopReason ?? undefined,
        };
      }
    } catch {
      // Parse failure
    }

    return null;
  }
}
