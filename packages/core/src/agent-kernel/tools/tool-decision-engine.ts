import type { LlmProvider } from "../../llm/llm.provider.js";
import type {
  AgentContext,
  AgentPlan,
  AgentObservation,
  ArtifactRef,
  ExecutionOrchestrator,
  IAssistantMessageStream,
  PermissionPolicy,
  PlannedToolCall,
  RoutedIntent,
  ToolCallSummary,
  ToolDecision,
  ToolDecisionEngine as ToolDecisionEngineInterface,
} from "../loop-types.js";
import { INTENT_SKILL_MAP, type SkillSummary } from "./tool-types.js";
import type { ToolArgumentBuilder } from "./tool-argument-builder.js";
import type {
  ToolRetriever,
  ToolRetrievalResult,
  ToolCallHistoryEntry,
} from "./tool-retriever.js";
import type { EmbeddingService } from "../context/embedding-service.js";
import type { AgentEventBus } from "../agent-event-bus.js";
import type { ModelRouter } from "../model-router.js";
import { checkAnyOfUnsatisfied } from "./tool-schema-utils.js";
import { RichCardBuilder } from "./rich-card-builder.js";

const MARKDOWN_RESPONSE_POLICY = `Response format policy:
- Default to structured Markdown output unless the user explicitly asks for plain text.
- For informational answers: use ##/### headings, short intro, grouped bullets, tables when comparing, **bold** for key conclusions, fenced code blocks or inline code for code/commands/paths, ordered lists for multi-step plans.
- For product/resource/search results: give a summary first, then a structured table, then filtering suggestions, then follow-up directions.
- Avoid "以下是..." repetitive openings. Do not repeat the same content in the same paragraph.
- Do not use raw HTML — the Markdown renderer handles formatting.
- Use the same language as the user.`;

import type {
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from "../../llm/llm.types.js";

// ── Tool loop stop reason (§5.6 of duplicate-streaming bugfix) ──────────

export type ToolLoopStopReason =
  | "missing_required_arguments"
  | "schema_validation_failed"
  | "permission_denied"
  | "all_tools_failed"
  | "duplicate_tool_call_blocked"
  | "max_iterations";

// ── Decision metadata (§P1-4) ─────────────────────────────────────────────

/** Audit metadata recorded on each PlannedToolCall for debugging tool selection. */
export interface DecisionMetadata {
  /** Which layer made the final selection. */
  decisionPath:
    | "plan"
    | "intent_match"
    | "priority"
    | "deterministic_scorer"
    | "llm_semantic"
    | "scorer_fallback"
    | "intent_skill_map"
    | "no_tool";
  /** Whether an LLM call was involved in the selection. */
  llmSelectionUsed: boolean;
  /** Top-K candidates from ToolRetriever with scores and reasons. */
  retrievalMetadata?: {
    query: string;
    topK: number;
    candidates: Array<{
      skillId: string;
      score: number;
      matchReasons: string[];
    }>;
    fallbackUsed: boolean;
  };
  /** Reason for asking clarification instead of selecting. */
  clarificationReason?: string;
}

/**
 * Structured output from the LLM tool reranker (§P1).
 * Replaces the simple string-based "tool ID or none" with a
 * three-way decision that enables proper no-tool rejection.
 */
export interface LlmToolDecision {
  decision: "select" | "none" | "clarify";
  /** Tool ID (only for "select"). */
  skillId?: string;
  /** Confidence score 0.0–1.0. */
  confidence: number;
  /** Human-readable explanation for audit/debug. */
  reason: string;
  /** Clarification question (only for "clarify"). */
  missingInfo?: string;
}

export interface ToolDecisionEngineDeps {
  /** List all available skills with their summaries. */
  listSkills: () => Promise<SkillSummary[]>;
  /** Optional lightweight LLM for semantic tool selection (layer 2). */
  llm?: LlmProvider;
  /** Optional schema-aware tool argument builder. Falls back to heuristics. */
  argumentBuilder?: ToolArgumentBuilder;
  /** Optional ToolRetriever for multi-layer tool retrieval at scale (§2). */
  toolRetriever?: ToolRetriever;
  /** Optional embedding service for semantic similarity scoring. */
  embeddingService?: EmbeddingService;
  /** §P1-2: Shared skill embedding cache — pre-warmed at startup.
   *  When provided, passed through to ToolRetriever to avoid duplicate
   *  embedding API calls between IntentRouter and ToolRetriever. */
  skillEmbeddingCache?: import("./skill-embedding-cache.js").SkillEmbeddingCache;
  /** Recent tool call history for success/failure weighting. */
  recentHistory?: ToolCallHistoryEntry[];
  /** Current permission mode for safety-aware scoring. */
  permissionMode?: "ask" | "auto" | "full";

  // ── Streaming execution deps (LLM native function calling) ──
  /** Event bus for streaming deltas and lifecycle events. */
  eventBus: AgentEventBus;
  /** Model router for LLM streaming with tool definitions. */
  modelRouter: ModelRouter;
  /** Permission policy for runtime tool-call safety checks. */
  permissionPolicy: PermissionPolicy;
  /** Orchestrator that executes validated tool calls. */
  executionOrchestrator: ExecutionOrchestrator;
  /** Optional — detects prompt injection in tool results before model context (§Step 1b audit). */
  injectionDetector?: import("../safety/prompt-injection-detector.js").PromptInjectionDetector;
  /** Persist the final assistant message with metadata. */
  saveMessage: (msg: {
    id: string;
    conversationId: string;
    role: "assistant";
    content: string;
    runId: string;
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
}

/**
 * ToolDecisionEngine — 三层工具决策漏斗：
 *
 *   Layer 1 (Regex rules):    IntentRouter 预匹配 → candidateSkills
 *   Layer 2 (Deterministic):  高置信度时直接选中，省去 LLM 调用
 *   Layer 3 (LLM semantic):   歧义时用 LLM 从 Top-N 候选中精准选择
 *
 * 决策优先级：
 *   1. Plan 中有 tool 步骤 → 直接执行
 *   2. intent.requiresTool === false → no_tool
 *   3. candidateSkills 精确匹配 → use_tool
 *   4. use_skill + 确定性评分 ≥ 0.8 → use_tool (跳过 LLM)
 *   5. use_skill + LLM 语义选择 → use_tool / ask_clarification
 *   6. INTENT_SKILL_MAP 兜底
 */
export class ToolDecisionEngine implements ToolDecisionEngineInterface {
  constructor(private readonly deps: ToolDecisionEngineDeps) {}

  async decide(
    input: {
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      previousObservation?: AgentObservation;
      prioritySkills?: Array<{
        skillId: string;
        reason: string;
        argumentsHint?: Record<string, unknown>;
      }>;
    },
    signal: AbortSignal,
  ): Promise<ToolDecision> {
    const { context, intent, plan, previousObservation, prioritySkills } =
      input;

    // ── Priority lane: reflection-suggested tools ──────────────────────
    // When the reflection engine suggests specific tools (e.g. search→detail
    // chain), try these first with their argumentsHint before falling back
    // to normal candidate matching.
    if (prioritySkills && prioritySkills.length > 0 && !plan) {
      const availableSkills = await this.listEnabledSkills();
      const priorityCalls: PlannedToolCall[] = [];

      for (const ps of prioritySkills) {
        const skill = availableSkills.find(
          (s) =>
            s.id === ps.skillId ||
            capabilityNameFromToolId(s.id) === ps.skillId,
        );
        if (!skill) continue;

        const built = await this.buildPlannedToolCall(
          context,
          skill,
          `Reflection priority: ${ps.reason}`,
          previousObservation,
          signal,
        );
        if (built.call) {
          // Inject argumentsHint from reflection into the call
          if (ps.argumentsHint) {
            built.call.arguments = {
              ...built.call.arguments,
              ...ps.argumentsHint,
            };
          }
          priorityCalls.push(built.call);
        }
      }

      if (priorityCalls.length > 0) {
        return {
          type: "use_tool",
          toolCalls: priorityCalls,
          reason: `Reflection priority: ${prioritySkills.map((ps) => ps.reason).join("; ")}`,
        };
      }
    }

    // If plan has tool steps, use those
    if (plan && plan.steps.some((s) => s.type === "tool" && s.skillId)) {
      const availableSkills = await this.listEnabledSkills();
      const toolSteps = plan.steps.filter(
        (s) => s.type === "tool" && s.skillId,
      );
      const planMeta: DecisionMetadata = {
        decisionPath: "plan",
        llmSelectionUsed: false,
      };
      const planToolCalls: PlannedToolCall[] = [];
      const planClarifications: string[] = [];
      for (const step of toolSteps) {
        const skill = availableSkills.find((item) => item.id === step.skillId);
        if (!skill) continue;
        const riskLevel = maxRisk(
          step.riskLevel,
          skill.riskHints.defaultRisk ?? "low",
        );
        if (step.input && Object.keys(step.input).length > 0) {
          planToolCalls.push({
            id: `tc_${crypto.randomUUID()}`,
            skillId: step.skillId!,
            name: step.title,
            arguments: step.input,
            permissions: skill.permissions,
            reason: `Plan step: ${step.description}`,
            riskLevel,
            requiresApproval: riskLevel === "high" || riskLevel === "critical",
            timeoutMs: Math.min(skill.defaultTimeoutMs, skill.maxTimeoutMs),
            riskHints: skill.riskHints,
            inputSchema: skill.inputSchema,
            metadata: { decisionPath: "plan", llmSelectionUsed: false },
          });
        } else {
          const built = await this.buildPlannedToolCall(
            context,
            skill,
            `Plan step: ${step.description}`,
            previousObservation,
            signal,
            planMeta,
          );
          if (built.call) {
            built.call.riskLevel = maxRisk(built.call.riskLevel, riskLevel);
            built.call.requiresApproval =
              built.call.riskLevel === "high" ||
              built.call.riskLevel === "critical";
            planToolCalls.push(built.call);
          } else if (built.clarification) {
            planClarifications.push(built.clarification);
          }
        }
      }
      // If all plan steps failed with missing params, ask clarification
      if (planToolCalls.length === 0 && planClarifications.length > 0) {
        return {
          type: "ask_clarification",
          question: planClarifications.join(" "),
          reason: `Plan requires missing parameters: ${planClarifications.join("; ")}`,
        };
      }
      return {
        type: "use_tool",
        toolCalls: planToolCalls,
        reason: `Executing ${toolSteps.length} tool step(s) from plan`,
      };
    }

    // No tool needed for these intent types
    if (!intent.requiresTool) {
      return {
        type: "no_tool",
        reason: `Intent '${intent.type}' doesn't require tools`,
      };
    }

    // Get available skills
    let availableSkills: SkillSummary[] = [];
    try {
      availableSkills = await this.listEnabledSkills();
    } catch (err) {
      // Skill catalog unavailable — fall back to no_tool
      console.warn(
        "[ToolDecisionEngine] Skill catalog unavailable, falling back to no_tool:",
        (err as Error).message,
      );
      return {
        type: "no_tool",
        reason: "Skill catalog unavailable",
      };
    }

    // Match intent candidate skills to available skills.
    // Supports both fully-qualified ids (<skill-id>:<capability>) and
    // unqualified capability names for backward compatibility.
    const matchedSkills = intent.candidateSkills
      .flatMap((candidateId) =>
        availableSkills.filter(
          (s) =>
            s.id === candidateId ||
            capabilityNameFromToolId(s.id) === candidateId ||
            s.name.toLowerCase().includes(candidateId.toLowerCase()),
        ),
      )
      .filter((s, idx, arr) => arr.findIndex((x) => x.id === s.id) === idx); // dedupe

    // ── Multi-layer tool retrieval (§2, §P1-4 of architecture next steps) ──
    const shouldUseRetrieval =
      (intent.type === "use_skill" || matchedSkills.length === 0) &&
      intent.requiresTool;

    if (shouldUseRetrieval) {
      let scored: ScoredSkill[];
      let retrievalMetaForAudit:
        | DecisionMetadata["retrievalMetadata"]
        | undefined;

      // Layer 1.5: ToolRetriever multi-layer retrieval (§2 of architecture next steps)
      if (this.deps.toolRetriever) {
        try {
          const recentHistory = deriveRecentHistory(context.toolResults);

          const retrievalResult = await this.deps.toolRetriever.retrieve({
            query: context.currentMessage.content,
            intent,
            availableSkills,
            embeddingService: this.deps.embeddingService,
            skillEmbeddingCache: this.deps.skillEmbeddingCache,
            recentHistory: this.deps.recentHistory ?? recentHistory,
            permissionMode: this.deps.permissionMode,
          });
          scored = retrievalResult.tools.map((st) => ({
            skill: st.skill,
            score: st.score,
            matchReasons: st.matchReasons,
          }));

          // Build retrieval metadata for audit trail (§P1-4)
          retrievalMetaForAudit = {
            query: context.currentMessage.content,
            topK: retrievalResult.topK,
            candidates: retrievalResult.tools.map((st) => ({
              skillId: st.skill.id,
              score: st.score,
              matchReasons: st.matchReasons,
            })),
            fallbackUsed: retrievalResult.fallbackUsed,
          };

          if (
            scored.length === 0 ||
            (retrievalResult.fallbackUsed && scored[0]!.score < 0.1)
          ) {
            scored = scoreSkills(
              context.currentMessage.content,
              availableSkills,
            );
          }
        } catch (err) {
          console.warn(
            "[ToolDecisionEngine] ToolRetriever.retrieve threw, falling back to inline scorer:",
            (err as Error).message,
          );
          scored = scoreSkills(context.currentMessage.content, availableSkills);
        }
      } else {
        scored = scoreSkills(context.currentMessage.content, availableSkills);
      }

      const best = scored[0];
      // MIN_SCORE threshold: below this, scorer signals are too weak to
      // justify any tool call. Prevents false positives from single-bigram
      // or single-keyword matches (max = 0.1 with current weights).
      const MIN_TOOL_SCORE = 0.3;
      if (!best || best.score <= 0) {
        // No match at all → fall through to INTENT_SKILL_MAP below
      } else if (best.score < MIN_TOOL_SCORE) {
        // All candidates have weak scores — fall through to INTENT_SKILL_MAP
        // rather than eagerly calling a low-confidence tool
      } else {
        const runnerUp = scored[1];

        // Clear-winner threshold adjusted for reduced bigram weights.
        // 0.6 is reachable with: verbatim name match (0.5) + one other
        // signal (category 0.4, desc 0.2, or bigram 0.15).
        const isClearWinner =
          best.score >= 0.6 &&
          (!runnerUp ||
            runnerUp.score === 0 ||
            best.score - runnerUp.score > 0.3);

        if (isClearWinner) {
          const decisionMeta: DecisionMetadata = {
            decisionPath: "deterministic_scorer",
            llmSelectionUsed: false,
            retrievalMetadata: retrievalMetaForAudit,
          };
          return this.buildUseToolDecision(
            [best.skill],
            `use_skill deterministic (score: ${best.score.toFixed(2)})`,
            decisionMeta,
            context,
            previousObservation,
            signal,
          );
        }

        // Layer 2: Ambiguous — ask clarification if scores too close
        if (
          runnerUp &&
          runnerUp.score > 0 &&
          best.score - runnerUp.score < 0.1
        ) {
          const candidates = scored
            .filter((s) => s.score > 0)
            .slice(0, 3)
            .map((s) => s.skill.name)
            .join(", ");
          return attachTrace(
            {
              type: "ask_clarification",
              question: `找到多个匹配技能（${candidates}），请问要使用哪个？`,
              reason: `Multiple skills match with close scores (top: ${best.score.toFixed(2)}, runner-up: ${runnerUp.score.toFixed(2)})`,
            },
            {
              decisionPath: "deterministic_scorer",
              llmSelectionUsed: false,
              retrievalMetadata: retrievalMetaForAudit,
            },
          );
        }

        // Layer 3: LLM semantic selection with structured output (§P1)
        // Uses three-way decision: select / none / clarify.
        // Eliminates the risky "scorer fallback" path for low-confidence cases.
        if (this.deps.llm) {
          const topCandidates = scored.filter((s) => s.score > 0).slice(0, 10);
          try {
            const llmDecision = await this.selectSkillWithLlm(
              context.currentMessage.content,
              topCandidates.map((s) => s.skill),
              best.score, // Pass scorer confidence for single-candidate gate
            );
            if (llmDecision) {
              if (llmDecision.decision === "select" && llmDecision.skillId) {
                const selected = topCandidates.find(
                  (s) => s.skill.id === llmDecision.skillId,
                );
                if (selected) {
                  const decisionMeta: DecisionMetadata = {
                    decisionPath: "llm_semantic",
                    llmSelectionUsed: true,
                    retrievalMetadata: retrievalMetaForAudit,
                  };
                  return this.buildUseToolDecision(
                    [selected.skill],
                    `LLM selected: ${llmDecision.skillId} (confidence: ${llmDecision.confidence.toFixed(2)})`,
                    decisionMeta,
                    context,
                    previousObservation,
                    signal,
                  );
                }
              }

              if (llmDecision.decision === "clarify") {
                return {
                  type: "ask_clarification",
                  question: llmDecision.missingInfo ?? "请问您想使用哪个工具？",
                  reason: `LLM requested clarification: ${llmDecision.reason}`,
                };
              }

              // llmDecision.decision === "none" — no tool matches
              if (llmDecision.decision === "none") {
                return {
                  type: "no_tool",
                  reason: `LLM determined no tool matches: ${llmDecision.reason}`,
                };
              }
            }
          } catch (err) {
            console.warn(
              "[ToolDecisionEngine] LLM semantic selection threw, falling back to scorer match:",
              (err as Error).message,
            );
          }
        }

        // LLM unavailable or couldn't decide — use best scorer match
        // but only if score meets the minimum threshold. Below that,
        // fall through to INTENT_SKILL_MAP rather than risking a
        // low-confidence false positive.
        if (best.score >= MIN_TOOL_SCORE) {
          const decisionMeta: DecisionMetadata = {
            decisionPath: "scorer_fallback",
            llmSelectionUsed: !!this.deps.llm,
            retrievalMetadata: retrievalMetaForAudit,
          };
          return this.buildUseToolDecision(
            [best.skill],
            `use_skill scorer fallback: ${best.skill.id} (score: ${best.score.toFixed(2)})`,
            decisionMeta,
            context,
            previousObservation,
            signal,
          );
        }
        // Below MIN_TOOL_SCORE — fall through to INTENT_SKILL_MAP
      }
    }

    if (matchedSkills.length === 0) {
      // Check intent skill map for fallback
      const fallbackIds = INTENT_SKILL_MAP[intent.type] ?? [];
      const fallbackSkills = fallbackIds
        .flatMap((id) =>
          availableSkills.filter(
            (s) => s.id === id || capabilityNameFromToolId(s.id) === id,
          ),
        )
        .filter((s, idx, arr) => arr.findIndex((x) => x.id === s.id) === idx);

      if (fallbackSkills.length === 0) {
        return {
          type: "no_tool",
          reason: `No available skills matched intent '${intent.type}'`,
        };
      }

      const fallbackBuilt = await Promise.all(
        fallbackSkills.map((skill) =>
          this.buildPlannedToolCall(
            context,
            skill,
            `Fallback match for intent '${intent.type}'`,
            previousObservation,
            signal,
          ),
        ),
      );
      const fallbackToolCalls = fallbackBuilt
        .filter((b) => b.call !== null)
        .map((b) => b.call!);
      const fallbackClarifications = fallbackBuilt
        .filter((b) => b.clarification)
        .map((b) => b.clarification!);
      if (fallbackToolCalls.length === 0 && fallbackClarifications.length > 0) {
        return {
          type: "ask_clarification",
          question: fallbackClarifications.join(" "),
          reason: `All fallback skills require missing parameters`,
        };
      }
      return {
        type: "use_tool",
        toolCalls: fallbackToolCalls,
        reason: `Matched ${fallbackSkills.length} fallback skill(s) for intent '${intent.type}'`,
      };
    }

    const builtResults = await Promise.all(
      matchedSkills.map((skill) =>
        this.buildPlannedToolCall(
          context,
          skill,
          `Matched for intent '${intent.type}'`,
          previousObservation,
          signal,
        ),
      ),
    );
    const matchedToolCalls = builtResults
      .filter((b) => b.call !== null)
      .map((b) => b.call!);
    const matchedClarifications = builtResults
      .filter((b) => b.clarification)
      .map((b) => b.clarification!);
    if (matchedToolCalls.length === 0 && matchedClarifications.length > 0) {
      return {
        type: "ask_clarification",
        question: matchedClarifications.join(" "),
        reason: `All matched skills require missing parameters`,
      };
    }
    return {
      type: "use_tool",
      toolCalls: matchedToolCalls,
      reason: `Matched ${matchedSkills.length} skill(s) for intent '${intent.type}'`,
    };
  }

  private async listEnabledSkills(): Promise<SkillSummary[]> {
    const allSkills = await this.deps.listSkills();
    return allSkills.filter((skill) => skill.enabled);
  }

  /**
   * Build a use_tool decision from matched skills.
   */
  private async buildUseToolDecision(
    skills: SkillSummary[],
    reason: string,
    decisionMeta?: DecisionMetadata,
    context?: AgentContext,
    previousObservation?: AgentObservation,
    signal?: AbortSignal,
  ): Promise<ToolDecision> {
    const built = await Promise.all(
      skills.map((skill) =>
        this.buildPlannedToolCall(
          context!,
          skill,
          `Matched: ${skill.id}`,
          previousObservation,
          signal,
          decisionMeta,
        ),
      ),
    );

    // Collect clarification reasons from failed builds
    const clarifications = built
      .filter((b) => b.clarification)
      .map((b) => b.clarification!);

    const toolCalls = built.filter((b) => b.call !== null).map((b) => b.call!);

    // If ALL tools failed with missing params, ask clarification (§P0-1 fix)
    if (toolCalls.length === 0 && clarifications.length > 0) {
      return {
        type: "ask_clarification",
        question: clarifications.join(" "),
        reason: `All ${skills.length} skill(s) require missing parameters: ${clarifications.join("; ")}`,
        decisionPath: decisionMeta?.decisionPath,
        retrievalTopK: decisionMeta?.retrievalMetadata?.topK,
        retrievalCandidateCount:
          decisionMeta?.retrievalMetadata?.candidates?.length,
        retrievalFallback: decisionMeta?.retrievalMetadata?.fallbackUsed,
      };
    }

    return {
      type: "use_tool",
      reason,
      toolCalls,
      decisionPath: decisionMeta?.decisionPath,
      retrievalTopK: decisionMeta?.retrievalMetadata?.topK,
      retrievalCandidateCount:
        decisionMeta?.retrievalMetadata?.candidates?.length,
      retrievalFallback: decisionMeta?.retrievalMetadata?.fallbackUsed,
    };
  }

  /**
   * LLM-based tool reranker with structured output (§P1).
   *
   * Presents top-10 candidates to the LLM and requests a structured
   * JSON decision. Supports three outcomes:
   *   - "select": a specific tool is the best match
   *   - "none": no tool matches the user's intent
   *   - "clarify": ambiguous — need more info from the user
   *
   * The structured output enables proper no-tool rejection and
   * clarification, eliminating the risky scorer fallback path.
   */
  private async selectSkillWithLlm(
    userMessage: string,
    candidates: SkillSummary[],
    /** Best scorer score among candidates (for single-candidate gate). */
    bestScore?: number,
  ): Promise<LlmToolDecision | null> {
    if (!this.deps.llm || candidates.length === 0) return null;

    // Single-candidate fast path: only auto-select when the scorer found
    // a strong match. A single candidate just above MIN_TOOL_SCORE (0.3)
    // is NOT strong enough — let the LLM evaluate it or fall through to
    // no_tool/clarify. This prevents a weak single candidate from
    // bypassing the structured none/select check.
    //
    // Threshold: 0.6 = verbatim name match (0.5) + at least one other
    // signal (category/description/bigram). This is the same as the
    // deterministic clear-winner threshold.
    const SINGLE_CANDIDATE_AUTO_THRESHOLD = 0.6;
    if (
      candidates.length === 1 &&
      bestScore !== undefined &&
      bestScore >= SINGLE_CANDIDATE_AUTO_THRESHOLD
    ) {
      return {
        decision: "select",
        skillId: candidates[0]!.id,
        confidence: Math.min(0.95, bestScore),
        reason: `Single candidate with strong scorer match (score: ${bestScore.toFixed(2)})`,
      };
    }

    // Single candidate but weak score — still ask the LLM.
    // If no LLM available, return null so the caller falls through
    // to the scorer fallback (which checks MIN_TOOL_SCORE).
    if (
      candidates.length === 1 &&
      (!this.deps.llm ||
        bestScore === undefined ||
        bestScore < SINGLE_CANDIDATE_AUTO_THRESHOLD)
    ) {
      // Let the LLM evaluate this single candidate — it may return "none"
      // if it's a poor match.
    }

    // Send top-10 to LLM (up from top-5) so embedding-displaced
    // skills still get a chance at LLM review.
    const topForLlm = candidates.slice(0, 10);

    const skillOptions = topForLlm
      .map(
        (s, i) =>
          `${i + 1}. ${s.id}\n   Name: ${s.name}\n   Description: ${s.description}`,
      )
      .join("\n\n");

    const prompt = `Select the BEST tool for this user request.

User: "${userMessage}"

Candidate tools:
${skillOptions}

Respond with a JSON object ONLY (no markdown, no extra text):
{
  "decision": "select" | "none" | "clarify",
  "skillId": "<tool-id>" (required if decision=select, null otherwise),
  "confidence": 0.0 to 1.0,
  "reason": "<one-sentence explanation>",
  "missingInfo": "<question to ask user>" (required if decision=clarify, null otherwise)
}

Rules:
- "select": pick the SINGLE best tool. Return its exact ID and a confidence score.
- "none": NO tool matches. Use this when the user is asking a general question, making small talk, or requesting something none of the tools can do.
- "clarify": there are multiple plausible tools AND you need more info to decide. Provide a specific question in "missingInfo".

IMPORTANT: return ONLY the JSON object. No markdown code fences, no surrounding text.`;

    const messages = [{ role: "user" as const, content: prompt }];
    let response = "";

    for await (const chunk of this.deps.llm.streamChat({ messages })) {
      response += chunk.delta;
    }

    // Parse the JSON response — strip markdown fences if present
    const cleaned = response
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "");
    try {
      const parsed = JSON.parse(cleaned) as {
        decision?: string;
        skillId?: string | null;
        confidence?: number;
        reason?: string;
        missingInfo?: string | null;
      };

      // Validate decision field
      const decision = parsed.decision;
      if (
        decision !== "select" &&
        decision !== "none" &&
        decision !== "clarify"
      ) {
        return null; // Invalid — fall through to scorer
      }

      // Validate skillId for "select" decisions
      if (decision === "select") {
        const skillId = parsed.skillId?.trim();
        if (!skillId) return null; // Missing required field
        const valid = candidates.find((s) => s.id === skillId);
        if (!valid) return null; // Hallucinated ID
        return {
          decision: "select",
          skillId: valid.id,
          confidence: clampConfidence(parsed.confidence),
          reason: parsed.reason ?? "LLM selected best match",
        };
      }

      if (decision === "clarify") {
        return {
          decision: "clarify",
          confidence: clampConfidence(parsed.confidence),
          reason: parsed.reason ?? "LLM requested clarification",
          missingInfo: parsed.missingInfo?.trim() ?? "请问您想使用哪个工具？",
        };
      }

      // decision === "none"
      return {
        decision: "none",
        confidence: clampConfidence(parsed.confidence),
        reason: parsed.reason ?? "LLM determined no tool matches",
      };
    } catch {
      // JSON parse failed — try legacy plain-text format as fallback
      const trimmed = response.trim();
      if (trimmed === "none" || trimmed === '"none"') {
        return {
          decision: "none",
          confidence: 0.8,
          reason: "LLM returned none",
        };
      }
      const valid = candidates.find((s) => s.id === trimmed);
      if (valid) {
        return {
          decision: "select",
          skillId: valid.id,
          confidence: 0.7,
          reason: "LLM selected (legacy plain-text format)",
        };
      }
      return null;
    }
  }

  /**
   * Build a PlannedToolCall from a skill summary, including argument sources
   * and schema. Returns null with a clarification question if required
   * arguments are missing.
   */
  private async buildPlannedToolCall(
    context: AgentContext,
    skill: SkillSummary,
    reason: string,
    previousObservation?: AgentObservation,
    signal?: AbortSignal,
    decisionMeta?: DecisionMetadata,
  ): Promise<{
    call: PlannedToolCall | null;
    clarification?: string;
  }> {
    const {
      arguments: args,
      sources,
      missing,
    } = await this.buildToolArgumentsAsync(
      context,
      skill,
      previousObservation,
      signal,
    );

    // If required args are missing, trigger clarification
    if (missing.length > 0) {
      return {
        call: null,
        clarification: `缺少必要参数: ${missing.join(", ")}。请提供后重试。`,
      };
    }

    return {
      call: {
        id: `tc_${crypto.randomUUID()}`,
        skillId: skill.id,
        name: skill.name,
        arguments: args,
        permissions: skill.permissions,
        reason,
        riskLevel: skill.riskHints.defaultRisk,
        requiresApproval:
          skill.riskHints.defaultRisk === "high" ||
          skill.riskHints.defaultRisk === "critical",
        timeoutMs: Math.min(skill.defaultTimeoutMs, skill.maxTimeoutMs),
        riskHints: skill.riskHints,
        inputSchema: skill.inputSchema,
        projectionHints: skill.projectionHints,
        argumentSources: sources as PlannedToolCall["argumentSources"],
        metadata: decisionMeta
          ? {
              decisionPath: decisionMeta.decisionPath,
              llmSelectionUsed: decisionMeta.llmSelectionUsed,
              retrievalMetadata: decisionMeta.retrievalMetadata,
              clarificationReason: decisionMeta.clarificationReason,
            }
          : undefined,
      },
    };
  }

  /**
   * Build tool arguments using the argument builder when available,
   * falling back to heuristic extraction.
   * Returns the full result including sources and missing fields for provenance.
   */
  private async buildToolArgumentsAsync(
    context: AgentContext,
    skill?: SkillSummary,
    previousObservation?: AgentObservation,
    signal?: AbortSignal,
  ): Promise<{
    arguments: Record<string, unknown>;
    sources: Array<{ arg: string; source: string; ref?: string }>;
    missing: string[];
  }> {
    // Use schema-aware argument builder when available
    if (this.deps.argumentBuilder && skill) {
      try {
        const result = await this.deps.argumentBuilder.build(
          {
            context,
            intent: {
              type: "use_skill",
              confidence: 0.9,
              requiresPlanning: false,
              requiresTool: true,
              requiresApproval: false,
              riskLevel: "low",
              candidateSkills: [skill.id],
              reason: "tool decision engine",
            },
            skill,
            schema: skill.inputSchema,
            previousObservation,
          },
          signal ?? new AbortController().signal,
        );
        return {
          arguments: result.arguments,
          sources: result.sources,
          missing: result.missing,
        };
      } catch (err) {
        // Fall through to heuristic
        console.warn(
          "[ToolDecisionEngine] Argument builder threw, falling back to heuristics:",
          (err as Error).message,
        );
      }
    }

    // Heuristic fallback (original implementation)
    const args = buildToolArgumentsHeuristic(context, skill);
    return { arguments: args, sources: [], missing: [] };
  }

  // ── Streaming execution (LLM native function calling) ────────────────

  /**
   * Execute the tool-use path via LLM native function calling.
   *
   * Replaces the separate execute→reflect→respond cycle with a single
   * LLM-driven streaming loop where text output and tool calls are
   * interleaved — Claude Code-style experience.
   *
   * Retains ToolRetriever (candidate filtering), ToolArgumentBuilder
   * (parameter validation), PermissionPolicy (safety checks), and
   * ExecutionOrchestrator (tool execution) as engineering safeguards.
   */
  async executeStreaming(
    input: {
      runId: string;
      conversationId: string;
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
      /** Pre-generated messageId from caller. Caller has already emitted agent.response.started. */
      messageId?: string;
      /** User-selected model for request-level routing. */
      modelId?: "dp" | "seed";
      /** User-selected permission mode for tool execution safety checks. */
      permissionMode?: "ask" | "auto" | "full";
      prioritySkills?: Array<{
        skillId: string;
        reason: string;
        argumentsHint?: Record<string, unknown>;
      }>;
      /** Optional IAssistantMessageStream for content-block parts emission (§Phase 3). */
      stream?: IAssistantMessageStream;
    },
    signal: AbortSignal,
  ): Promise<{
    messageId: string;
    content: string;
    artifacts: ArtifactRef[];
    toolCalls: ToolCallSummary[];
    /** §P0-7: Phase timing metrics for trace observability (milliseconds). */
    timing: {
      toolRetrievalMs: number;
      totalToolExecutionMs: number;
      firstRoundFirstTokenMs: number;
      finalRoundFirstTokenMs: number;
    };
  }> {
    const MAX_TOOL_ITERATIONS = 5;
    const { runId, conversationId, context, intent, plan } = input;
    const messageId = input.messageId ?? `msg_${crypto.randomUUID()}`;
    const stream = input.stream;
    let fullContent = "";
    const allArtifacts: ArtifactRef[] = [];
    const allToolCallSummaries: ToolCallSummary[] = [];
    // §5.9: Tool call signature dedup — prevent identical (skillId, args) calls
    const seenToolCallSignatures = new Set<string>();

    // Legacy agent.response.* emits removed — use agent.message.* via stream instead

    try {
      // 1. Build initial messages from AgentContext
      // §P1-4: First tool round uses slim mode — skip memories to reduce
      // prompt size. Full context is only needed for the final answer.
      const messages = this.buildStreamingMessages(
        context,
        plan,
        input.prioritySkills,
        { slim: true },
      );

      // 2. Load full skill catalog
      const allSkills = await this.deps.listSkills();

      // 3. Get candidate tools from ToolRetriever (§P0-3: track timing)
      const retrievalStart = Date.now();
      const retrieval = await this.retrieveStreamingTools(
        context,
        intent,
        allSkills,
        input.permissionMode,
      );
      const toolRetrievalMs = Date.now() - retrievalStart;
      const { tools, nameMap } = this.buildStreamingToolDefinitions(retrieval);

      // 4. Streaming loop: interleave text + tool calls
      let iteration = 0;
      let currentMessages = messages;
      let summarizeStatusId: string | undefined;
      // §P0-3: Aggregate timing across tool execution rounds
      let totalToolExecutionMs = 0;
      let firstRoundFirstTokenMs = 0;
      let finalRoundFirstTokenMs = 0;

      while (iteration < MAX_TOOL_ITERATIONS) {
        if (signal.aborted) break;
        iteration++;

        // §Phase 2a: Text parts are created lazily on first delta.
        // No pre-created empty text parts — streamLlmTurn handles it.
        // §P0-1: First-round text with tools is "progress" (thinking).
        const result = await this.streamLlmTurn(
          runId,
          conversationId,
          messageId,
          currentMessages,
          tools,
          signal,
          input.modelId,
          stream,
          undefined, // lazy creation — no pre-allocated textPartId
          "progress",
        );

        // §P0-3: Capture first-round first-token timing for trace
        if (iteration === 1) {
          firstRoundFirstTokenMs = result.firstTokenMs;
        }

        fullContent += result.textContent;

        // §Phase 2a: Deterministic preface — when the model goes
        // tool-first with no narrative text, emit a short factual
        // preface so the user immediately sees what's happening.
        if (
          result.toolCalls.length > 0 &&
          result.textContent.trim().length === 0 &&
          stream
        ) {
          const toolNames = result.toolCalls.map((tc) => {
            const skillId = nameMap.get(tc.function.name) ?? tc.function.name;
            const skill = allSkills.find((s) => s.id === skillId);
            return skill?.name ?? skillId;
          });
          const prefaceText =
            toolNames.length === 1
              ? `我先调用「${toolNames[0]}」检查相关信息。`
              : `我先调用${toolNames.map((n) => `「${n}」`).join("、")}检查相关信息。`;
          const prefacePart = stream.startTextPart("progress");
          stream.appendText(prefacePart.id, prefaceText);
          fullContent += prefaceText;
          stream.completeTextPart(prefacePart.id);
        }

        // Complete the "summarizing" status when LLM starts producing text
        if (summarizeStatusId && result.textContent && stream) {
          stream.updateStatus(summarizeStatusId, {
            status: "completed",
            label: "已整理搜索结果",
          });
        }

        // Complete the text part if one was created
        if (stream && result.textPartId) {
          stream.completeTextPart(result.textPartId);
        }

        // If no tool calls, LLM is done — exit loop
        if (result.toolCalls.length === 0) {
          // §P0-3: This is the final answer round — capture first-token timing
          if (finalRoundFirstTokenMs === 0) {
            finalRoundFirstTokenMs = result.firstTokenMs;
          }
          // §P1-3: When the LLM decides NOT to call tools, this text is
          // the final answer — promote from "progress" to "final" so
          // frontend renders it in the product area instead of thinking.
          if (stream && result.textPartId) {
            stream.updateTextPartRole(result.textPartId, "final");
          }
          break;
        }

        // §5.9: Tool call signature dedup — prevent identical calls in same run
        let duplicateBlocked = false;
        for (const tc of result.toolCalls) {
          const skillId = nameMap.get(tc.function.name) ?? tc.function.name;
          const signature = `${skillId}:${tc.function.arguments}`;
          if (seenToolCallSignatures.has(signature)) {
            if (stream) {
              stream.addError({
                code: "DUPLICATE_TOOL_CALL_BLOCKED",
                message: "已阻止重复工具调用。",
                recoverable: true,
              });
            }
            duplicateBlocked = true;
          }
          seenToolCallSignatures.add(signature);
        }
        if (duplicateBlocked) break;

        // Execute tool calls (§P0-3: track execution timing)
        const toolExecStart = Date.now();
        const toolResults = await this.executeToolCalls(
          runId,
          conversationId,
          result.toolCalls,
          nameMap,
          context,
          intent,
          allSkills,
          signal,
          stream,
          input.permissionMode,
        );

        // §P0-3: Track cumulative tool execution time
        totalToolExecutionMs += Date.now() - toolExecStart;

        allArtifacts.push(...toolResults.artifacts);

        // §5.6: Stop the tool loop immediately on deterministic errors.
        // Missing required arguments, schema validation failures, and
        // permission denials should NOT retry — they're structural, not
        // transient. Otherwise the LLM keeps selecting the same broken tool.
        if (toolResults.stop) {
          if (stream) {
            // Emit a clarifying error text part so the user sees an explanation
            const errorText = stream.startTextPart("final");
            stream.appendText(errorText.id, toolResults.stop.message);
            stream.completeTextPart(errorText.id);
          }
          fullContent += toolResults.stop.message;
          break;
        }

        // §Step 1b: Scan tool result summaries for prompt injection
        // before they enter the model context (matching legacy path safety).
        if (this.deps.injectionDetector) {
          for (const tc of toolResults.summaries) {
            if (tc.summary) {
              const detection = this.deps.injectionDetector.detect(tc.summary);
              if (detection.shouldBlock) {
                tc.summary = `[BLOCKED] Content blocked due to potential prompt injection (${detection.matches.length} matches).`;
                (tc as unknown as Record<string, unknown>).trust = "untrusted";
                (tc as unknown as Record<string, unknown>).blocked = true;
              }
            }
          }
        }
        allToolCallSummaries.push(...toolResults.summaries);

        // §P1-4: Direct final — when a completed tool is projected as final
        // answer, emit its modelObservation directly and skip the second LLM.
        const completedTools = toolResults.summaries.filter(
          (s) => s.status === "completed",
        );
        const finalProjections = completedTools
          .map((s) => projectToolResultForModel(s))
          .filter((p) => p.isFinalAnswer);

        if (finalProjections.length > 0 && stream) {
          for (const projection of finalProjections) {
            const finalPart = stream.startTextPart("final");
            stream.appendText(finalPart.id, projection.modelObservation);
            stream.completeTextPart(finalPart.id);
            fullContent += projection.modelObservation;
          }
          if (summarizeStatusId) {
            stream.updateStatus(summarizeStatusId, {
              status: "completed",
              label: "已完成",
            });
          }
          break;
        }

        // Inject tool results into messages for next iteration
        currentMessages = this.injectStreamingToolResults(
          currentMessages,
          result.toolCalls,
          toolResults,
        );

        // ── Post-tool status: let user know we're summarizing results ──
        if (stream) {
          const statusPart = stream.startStatus({
            label: "正在整理搜索结果...",
            metadata: { phase: "summarizing" },
          });
          summarizeStatusId = statusPart.id;
        }

        // If all tools failed or were denied, give the LLM one more
        // chance to explain the situation, then stop
        const allFailed = toolResults.summaries.every(
          (s) => s.status !== "completed",
        );
        if (allFailed && iteration >= 2) {
          // §P0-1: Final explanation after tool failures is "final" answer.
          const finalResult = await this.streamLlmTurn(
            runId,
            conversationId,
            messageId,
            currentMessages,
            undefined, // no tools — let LLM explain the failure
            signal,
            input.modelId,
            stream,
            undefined, // lazy text part
            "final",
          );
          // §P0-3: Capture final-round first-token timing
          finalRoundFirstTokenMs = finalResult.firstTokenMs;
          fullContent += finalResult.textContent;
          if (stream && finalResult.textPartId) {
            stream.completeTextPart(finalResult.textPartId);
          }
          break;
        }
      }

      // ── Deterministic fallback: if tools ran but LLM produced no text content ──
      if (allArtifacts.length > 0 && stream && !stream.hasTextContent()) {
        const toolNames = [
          ...new Set(allArtifacts.map((a) => a.name).filter(Boolean)),
        ];
        const fallbackText =
          toolNames.length > 0
            ? `已完成${toolNames.join("、")}的搜索，正在整理结果。你可以让我筛选、排序或展示更多详情。`
            : "工具执行已完成，正在整理结果。";
        const fallbackPart = stream.startTextPart("final");
        stream.appendText(fallbackPart.id, fallbackText);
        fullContent += fallbackText;
        stream.completeTextPart(fallbackPart.id);
      }

      // 5. Check for abort after loop — signal may have fired between
      //    streaming turns. The caller (handleUseTool) handles cancellation.
      if (signal.aborted) {
        throw Object.assign(new Error("Streaming aborted by user"), {
          name: "AbortError",
        });
      }

      // 6. Build rich cards from artifacts
      const richCards = this.buildStreamingRichCards(allArtifacts);

      // §P0-3: Log phase timing for trace observability
      // (Timing data is included in span metrics via agent-loop-engine)
      if (
        typeof process !== "undefined" &&
        process.env?.SUNPILOT_DEBUG_TIMING === "1"
      ) {
        console.debug("[ToolDecisionEngine] streaming timing:", {
          runId,
          toolRetrievalMs,
          totalToolExecutionMs,
          firstRoundFirstTokenMs,
          finalRoundFirstTokenMs,
          toolIterations: iteration,
        });
      }

      // 7. Save/complete — stream handles it when present, else direct
      if (stream) {
        // Pass rich cards through the stream so stream.complete() persists
        // them in message metadata and emits them in agent.message.completed.
        stream.setRichCards(richCards);
      } else {
        await this.deps.saveMessage({
          id: messageId,
          conversationId,
          role: "assistant",
          content: fullContent,
          runId,
          metadata: {
            toolCallIds: allToolCallSummaries.map((tc) => tc.id),
            artifactIds: allArtifacts.map((a) => a.id),
            richCards,
          },
        });

        // Legacy agent.response.completed removed —
        // use agent.message.completed via stream instead
      }

      return {
        messageId,
        content: fullContent,
        artifacts: allArtifacts,
        toolCalls: allToolCallSummaries,
        timing: {
          toolRetrievalMs,
          totalToolExecutionMs,
          firstRoundFirstTokenMs,
          finalRoundFirstTokenMs,
        },
      };
    } catch (error) {
      // Re-throw AbortError so caller can handle cancellation
      if (
        error instanceof Error &&
        (error.name === "AbortError" || signal.aborted)
      ) {
        throw error;
      }

      // Save partial content on non-abort errors
      if (stream) {
        // Stream handles error saving
        stream.addError({
          message: error instanceof Error ? error.message : String(error),
          code: "AGENT_STREAMING_FAILED",
          recoverable: false,
        });
      } else if (fullContent.length > 0) {
        try {
          await this.deps.saveMessage({
            id: messageId,
            conversationId,
            role: "assistant",
            content: fullContent + "\n\n[Response interrupted]",
            runId,
          });
        } catch {
          // Best effort
        }
      }
      throw error;
    }
  }

  // ── Streaming helpers ──────────────────────────────────────────────

  /**
   * Build the messages array from AgentContext for the LLM call.
   * Includes system prompt with tool hints from plan and priority skills.
   */
  /**
   * Build the message list for the LLM call.
   *
   * §P1-4: Accepts a `slim` flag for first-round tool calls. In slim mode,
   * memories and artifact context are omitted to reduce prompt size and
   * speed up tool selection. The full context (memories, artifacts) is
   * only included in the final answer round when the model needs all
   * available information.
   */
  private buildStreamingMessages(
    context: AgentContext,
    plan?: AgentPlan,
    prioritySkills?: Array<{
      skillId: string;
      reason: string;
      argumentsHint?: Record<string, unknown>;
    }>,
    opts?: { slim?: boolean },
  ): ChatMessage[] {
    const messages: ChatMessage[] = [];
    const slim = opts?.slim ?? false;

    // System prompt
    const systemParts: string[] = [
      context.system.persona,
      `You are an agent that works in visible, user-facing steps.
Before using tools, briefly tell the user what you are checking or doing.
After each tool result, summarize the relevant observation and decide the next action.
Do not reveal hidden chain-of-thought. Keep progress concise and factual.
Use the same language as the user.`,
      "When you need to use a tool, call it directly. When you have results, summarize them for the user.",
      "If you don't need any tools, just respond naturally.",
      // §P1-3: Script/content preservation — when a tool result contains
      // generated content (script, markdown, text, etc.), you MUST preserve
      // it verbatim. You may add a brief introduction or formatting but MUST
      // NOT rewrite, rephrase, or regenerate the tool's output content.
      "CRITICAL: When a tool result contains final generated content (scripts, documents, search results, etc.), keep the content exactly as provided by the tool. You may add a short introduction, but do NOT rewrite, rephrase, or replace the tool's output with your own version.",
      MARKDOWN_RESPONSE_POLICY,
    ];

    if (context.system.rules.length > 0) {
      systemParts.push(
        "\nRules:\n" + context.system.rules.map((r) => `- ${r}`).join("\n"),
      );
    }

    if (context.system.safety.length > 0) {
      systemParts.push(
        "\nSafety:\n" + context.system.safety.map((s) => `- ${s}`).join("\n"),
      );
    }

    // Plan guidance
    if (plan) {
      const planSteps = plan.steps
        .filter((s) => s.type === "tool" && s.skillId)
        .map((s) => `- ${s.skillId}: ${s.description ?? s.title}`)
        .join("\n");
      if (planSteps) {
        systemParts.push(
          `\nPlan for this task (${plan.goal}):\n${planSteps}\nFollow the plan order when possible, but adapt based on results.`,
        );
      }
    }

    // Priority skill hints from reflection
    if (prioritySkills && prioritySkills.length > 0) {
      const hints = prioritySkills
        .map((ps) => `- ${ps.skillId}: ${ps.reason}`)
        .join("\n");
      systemParts.push(
        `\nSuggested next tools based on previous results:\n${hints}`,
      );
    }

    messages.push({ role: "system", content: systemParts.join("\n") });

    // §P1-4: Memories — skip in slim (first tool round) mode.
    // Full memories are only needed for the final answer phase.
    if (!slim && context.memories.length > 0) {
      const memoryLines = context.memories.map(
        (m) =>
          `[${m.type}] ${m.title}: ${m.content} (confidence: ${m.confidence})`,
      );
      messages.push({
        role: "system",
        content: "Relevant memories:\n" + memoryLines.join("\n"),
      });
    }

    // Conversation history (always included — contains essential context)
    for (const msg of context.messages) {
      messages.push({
        role: msg.role as ChatMessage["role"],
        content: msg.content,
      });
    }

    // Current user message — include attachment URLs so the LLM can reference them
    const { content: userContent, attachments: userAttachments } =
      context.currentMessage;
    const attachmentLines =
      userAttachments && userAttachments.length > 0
        ? "\n\n[Attachments provided by user]:\n" +
          userAttachments
            .map((a) => {
              const ref =
                (a.url ?? a.dataUrl)
                  ? `: ${a.url || "(base64 dataUrl available)"}`
                  : "(no URL — image not yet uploaded)";
              return `- ${a.name} (${a.type})${ref}`;
            })
            .join("\n")
        : "";
    messages.push({
      role: "user",
      content: userContent + attachmentLines,
    });

    return messages;
  }

  /**
   * Retrieve candidate tools from ToolRetriever.
   * Falls back to all enabled skills when retriever returns empty.
   */
  private async retrieveStreamingTools(
    context: AgentContext,
    intent: RoutedIntent,
    allSkills: SkillSummary[],
    permissionMode?: "ask" | "auto" | "full",
  ): Promise<ToolRetrievalResult> {
    try {
      const result = await this.deps.toolRetriever!.retrieve({
        query: context.currentMessage.content,
        intent,
        availableSkills: allSkills,
        embeddingService: this.deps.embeddingService,
        skillEmbeddingCache: this.deps.skillEmbeddingCache,
        permissionMode: permissionMode ?? "auto",
      });

      if (result.tools.length > 0) {
        return result;
      }
    } catch {
      // Retriever failed — fall through to full skill list
    }

    // Fallback: limit to category-matched + top 10 enabled skills
    const maxFallbackSkills = 10;
    const enabledSkills = allSkills.filter((s) => s.enabled);
    // Prioritize skills matching the detected intent category
    const categoryMatched = enabledSkills.filter(
      (s) => s.category.toLowerCase() === intent.type.toLowerCase(),
    );
    const nonCategoryMatched = enabledSkills.filter(
      (s) => s.category.toLowerCase() !== intent.type.toLowerCase(),
    );
    const fallbackSkills = [...categoryMatched, ...nonCategoryMatched].slice(
      0,
      maxFallbackSkills,
    );
    return {
      tools: fallbackSkills.map((skill) => ({
        skill,
        score: 0.3,
        matchReasons: ["fallback: all enabled tools"],
      })),
      topK: fallbackSkills.length,
      fallbackUsed: true,
      topKReason: "retriever returned empty or failed — presenting all tools",
    };
  }

  /**
   * Convert scored tools into LLM ToolDefinitions.
   * Uses inputSchema from SkillSummary for the function parameters.
   */
  private buildStreamingToolDefinitions(retrieval: ToolRetrievalResult): {
    tools: ToolDefinition[];
    nameMap: Map<string, string>;
  } {
    // Limit to top 20 tools to avoid overwhelming the LLM
    const topTools = retrieval.tools.slice(0, 20);
    const usedNames = new Set<string>();
    const nameMap = new Map<string, string>();

    const tools = topTools.map((scored) => {
      const skill = scored.skill;
      const functionName = toProviderToolName(skill.id, usedNames);
      nameMap.set(functionName, skill.id);
      // §Schema fix: Normalize anyOf/oneOf → top-level required for LLM compat.
      // OpenAI function calling ignores anyOf/oneOf — the LLM needs a flat
      // required[] to know which params are mandatory.
      const parameters = normalizeSchemaForLLM(skill.inputSchema);

      return {
        type: "function" as const,
        function: {
          name: functionName,
          description: `${skill.name}: ${skill.description}${
            scored.matchReasons && scored.matchReasons.length > 0
              ? ` (matched: ${scored.matchReasons.join(", ")})`
              : ""
          }\nSunPilot skill id: ${skill.id}`,
          parameters,
        },
      };
    });

    return { tools, nameMap };
  }

  /**
   * One turn of LLM streaming. Returns accumulated text content and any
   * complete tool calls the LLM decided to make.
   */
  private async streamLlmTurn(
    runId: string,
    conversationId: string,
    messageId: string,
    messages: ChatMessage[],
    tools: ToolDefinition[] | undefined,
    signal: AbortSignal,
    modelId?: "dp" | "seed",
    stream?: IAssistantMessageStream,
    textPartId?: string,
    /** §P0-1: Semantic role for the text part created by this turn.
     *  "progress" = pre-tool thinking, "final" = post-tool answer. */
    textPartRole?: "progress" | "final",
  ): Promise<{
    textContent: string;
    toolCalls: ToolCall[];
    /** The text part ID that was used (lazily created on first delta). */
    textPartId?: string;
    /** §P0-3: Milliseconds to first text token from stream start. */
    firstTokenMs: number;
  }> {
    let textContent = "";
    const toolCallAccumulator = new Map<number, ToolCallAccumulator>();
    // Lazily-created text part ID — created on first text delta to avoid
    // empty text parts when the model goes tool-first with no narrative.
    let lazyTextPartId = textPartId;
    // §P0-3: First-token timing for observability
    let firstTokenMs = 0;
    const streamStartTime = Date.now();

    const modelCallId = `model_${crypto.randomUUID()}`;

    this.deps.eventBus.emit(
      "agent.model.started",
      {
        runId,
        modelCallId,
        provider: "llm.openai-compatible",
        model: "default",
      },
      { runId, conversationId },
    );

    try {
      for await (const chunk of this.deps.modelRouter.streamChat(
        "response_composition",
        {
          messages,
          tools: tools && tools.length > 0 ? tools : undefined,
          tool_choice: tools && tools.length > 0 ? "auto" : undefined,
          runId,
          modelCallId,
          modelId,
        },
        signal,
      )) {
        // Emit text delta to frontend
        if (chunk.delta.length > 0) {
          // §P0-3: Capture first-token latency on first text delta
          if (firstTokenMs === 0) {
            firstTokenMs = Date.now() - streamStartTime;
          }

          // §Phase 2a: Lazy text part creation — only create when the
          // model actually produces text, avoiding empty text parts.
          // §P0-1: Pass textPartRole so frontend can classify stably.
          if (stream && !lazyTextPartId) {
            const textPart = stream.startTextPart(textPartRole);
            lazyTextPartId = textPart.id;
          }

          textContent += chunk.delta;

          // Route deltas through stream when available (§Phase 3)
          // Legacy agent.response.delta removed — use agent.message.part.delta instead
          if (stream && lazyTextPartId) {
            stream.appendText(lazyTextPartId, chunk.delta);
          }

          this.deps.eventBus.emit(
            "agent.model.delta",
            { runId, modelCallId, delta: chunk.delta },
            { runId, conversationId },
          );
        }

        // Accumulate tool call deltas
        if (chunk.toolCalls) {
          // §P0-3: Treat first tool-call delta as first model output.
          if (firstTokenMs === 0) {
            firstTokenMs = Date.now() - streamStartTime;
          }
          for (const tcDelta of chunk.toolCalls) {
            let acc = toolCallAccumulator.get(tcDelta.index);
            if (!acc) {
              acc = {
                index: tcDelta.index,
                id: "",
                type: "function",
                functionName: "",
                functionArguments: "",
              };
              toolCallAccumulator.set(tcDelta.index, acc);
            }

            if (tcDelta.id) acc.id = tcDelta.id;
            if (tcDelta.type) acc.type = tcDelta.type;
            if (tcDelta.function?.name) {
              acc.functionName = tcDelta.function.name;
            }
            if (tcDelta.function?.arguments) {
              acc.functionArguments += tcDelta.function.arguments;
            }
          }
        }
      }

      this.deps.eventBus.emit(
        "agent.model.completed",
        { runId, modelCallId, outputTokens: textContent.length },
        { runId, conversationId },
      );
    } catch (error) {
      this.deps.eventBus.emit(
        "agent.model.failed",
        {
          runId,
          modelCallId,
          error: {
            code: "AGENT_MODEL_CALL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        { runId, conversationId },
      );
      throw error;
    }

    // Convert accumulators to ToolCall array
    const toolCalls: ToolCall[] = [];
    for (const acc of toolCallAccumulator.values()) {
      if (acc.id && acc.functionName) {
        toolCalls.push({
          id: acc.id,
          type: "function",
          function: {
            name: acc.functionName,
            arguments: acc.functionArguments || "{}",
          },
        });
      }
    }

    return { textContent, toolCalls, textPartId: lazyTextPartId, firstTokenMs };
  }

  /**
   * Execute tool calls from the LLM.
   * Validates arguments, checks permissions, and runs execution.
   */
  private async executeToolCalls(
    runId: string,
    conversationId: string,
    toolCalls: ToolCall[],
    toolNameMap: Map<string, string>,
    context: AgentContext,
    intent: RoutedIntent,
    allSkills: SkillSummary[],
    signal: AbortSignal,
    stream?: IAssistantMessageStream,
    permissionMode?: "ask" | "auto" | "full",
  ): Promise<{
    artifacts: ArtifactRef[];
    summaries: ToolCallSummary[];
    /** When set, the tool loop must stop immediately (deterministic error). */
    stop?: {
      reason: ToolLoopStopReason;
      message: string;
    };
  }> {
    const artifacts: ArtifactRef[] = [];
    const summaries: ToolCallSummary[] = [];

    for (const tc of toolCalls) {
      // Parse arguments
      let parsedArgs: Record<string, unknown>;
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        const failSummary: ToolCallSummary = {
          id: tc.id,
          skillId: tc.function.name,
          name: tc.function.name,
          status: "failed",
          summary: `Failed to parse tool arguments: ${tc.function.arguments.slice(0, 200)}`,
        };
        summaries.push(failSummary);
        if (stream) {
          stream.addError({
            message: failSummary.summary,
            code: "TOOL_ARGUMENT_PARSE_FAILED",
            recoverable: true,
          });
        }
        continue;
      }

      const skillId = toolNameMap.get(tc.function.name) ?? tc.function.name;

      // Find the skill in full skill catalog
      const skill = allSkills.find((s) => s.id === skillId);
      if (!skill) {
        const failSummary: ToolCallSummary = {
          id: tc.id,
          skillId,
          name: skillId,
          status: "failed",
          summary: `Unknown tool: ${skillId}. Available tools: ${allSkills.map((s) => s.id).join(", ")}`,
        };
        summaries.push(failSummary);
        if (stream) {
          stream.addError({
            message: failSummary.summary,
            code: "TOOL_UNKNOWN",
            recoverable: true,
          });
        }
        continue;
      }

      // Emit tool.selected
      this.deps.eventBus.emit(
        "agent.tool.selected",
        {
          runId,
          toolCallId: tc.id,
          skillId: skill.id,
          name: skill.name,
          riskLevel: "medium",
        },
        { runId, conversationId },
      );

      // Start status part via stream (§Phase 3)
      let statusPartId: string | undefined;
      if (stream) {
        const statusPart = stream.startStatus({
          label: `正在调用工具: ${skill.name}`,
          toolCallId: tc.id,
          metadata: { skillId: skill.id },
        });
        statusPartId = statusPart.id;
      }

      // Add tool_use part via stream (§P1-3: status lifecycle)
      if (stream) {
        stream.addToolUse({
          toolCallId: tc.id,
          skillId: skill.id,
          name: skill.name,
          inputPreview:
            Object.keys(parsedArgs).length > 0
              ? summarizeForPreview(parsedArgs)
              : undefined,
        });
        // Now that execution is starting, update status to running
        stream.updateToolUse(tc.id, { status: "running" });
      }

      // ── Argument validation gate (§5.4) ──────────────────────────
      // 1. canonicalize model args (normalize aliases)
      // 2. merge deterministic args from context/attachments
      // 3. validate against schema
      // 4. repair once if possible
      // 5. if still invalid: emit error part, skip execution
      let finalArgs = canonicalizeArgs(parsedArgs);
      let argumentSources: PlannedToolCall["argumentSources"] = [];
      if (this.deps.argumentBuilder && skill.inputSchema) {
        try {
          const built = await this.deps.argumentBuilder.build(
            {
              context,
              intent,
              skill,
              schema: skill.inputSchema,
            },
            signal,
          );
          // Merge: deterministic args from context override model args
          finalArgs = { ...finalArgs, ...built.arguments };
          argumentSources = built.sources;

          // §P0-fix: Check anyOf/oneOf disjunctions before missing-required check.
          // The argument builder may report `missing: []` when a disjunction
          // (e.g. imageUrl OR imageDataUrl) has no universally-required fields
          // but ALL branches are unsatisfied. In that case, the tool must NOT
          // be called — emit an error part instead.
          const anyOfUnsatisfied = checkAnyOfUnsatisfied(
            finalArgs,
            skill.inputSchema,
          );
          const hasMissingArgs = built.missing.length > 0 || anyOfUnsatisfied;

          if (hasMissingArgs) {
            // Try repair once
            try {
              const validationErrors = built.missing.map(
                (f) => `Missing required field: ${f}`,
              );
              const repaired = await this.deps.argumentBuilder.repair(
                {
                  skillId: skill.id,
                  name: skill.name,
                  currentArgs: finalArgs,
                  schema: skill.inputSchema,
                  validationErrors,
                },
                signal,
              );
              finalArgs = { ...finalArgs, ...repaired.arguments };

              // Re-check after repair
              const postRepairCheck = await this.deps.argumentBuilder.build(
                { context, intent, skill, schema: skill.inputSchema },
                signal,
              );
              const postAnyOfUnsatisfied = checkAnyOfUnsatisfied(
                { ...finalArgs, ...repaired.arguments },
                skill.inputSchema,
              );
              if (postRepairCheck.missing.length > 0 || postAnyOfUnsatisfied) {
                // Still missing required args after repair — do not execute
                const missingFields = postRepairCheck.missing.join(", ");
                const failSummary: ToolCallSummary = {
                  id: tc.id,
                  skillId: skill.id,
                  name: skill.name,
                  status: "failed",
                  summary: `Missing required arguments: ${missingFields}`,
                };
                summaries.push(failSummary);
                if (stream) {
                  if (statusPartId) {
                    stream.updateStatus(statusPartId, {
                      status: "failed",
                      label: `失败: ${skill.name} (缺少参数)`,
                    });
                  }
                  stream.updateToolUse(tc.id, { status: "failed" });
                  stream.addError({
                    message: `我还没有拿到可用于搜索的图片链接。请等待图片上传完成，或重新上传图片后我再继续搜索。`,
                    code: "TOOL_ARGUMENT_MISSING",
                    recoverable: true,
                  });
                }
                // §5.6: Stop the tool loop immediately on missing required args.
                // These are deterministic errors — retrying with the same context
                // will always produce the same result.
                return {
                  artifacts,
                  summaries,
                  stop: {
                    reason: "missing_required_arguments",
                    message:
                      "缺少可用图片引用，不能执行搜索。请上传图片后重试，或确认图片已上传完成。",
                  },
                };
              }
            } catch {
              // Repair failed — fall through and try execution anyway
            }
          }
        } catch {
          // Continue with canonicalized args if builder fails
        }
      }

      // Build a PlannedToolCall for execution
      const skillRisk = skill.riskHints?.defaultRisk ?? "medium";
      const plannedCall: PlannedToolCall = {
        id: tc.id,
        skillId: skill.id,
        name: skill.name,
        arguments: finalArgs,
        permissions: skill.permissions,
        reason: `LLM function calling selected ${skill.name}`,
        riskLevel: skillRisk,
        requiresApproval: skillRisk === "high" || skillRisk === "critical",
        timeoutMs: skill.defaultTimeoutMs || 60_000,
        riskHints: {
          defaultRisk: skillRisk,
        },
        argumentSources,
      };

      // Check permissions
      if (plannedCall.permissions && plannedCall.permissions.length > 0) {
        const permDecision = await this.deps.permissionPolicy.evaluate({
          userId: context.userId,
          runId,
          skillId: skill.id,
          permissions: plannedCall.permissions,
          arguments: finalArgs,
          context,
          permissionMode: permissionMode ?? "auto",
          riskHints: plannedCall.riskHints,
        });

        if (!permDecision.allowed) {
          const failSummary: ToolCallSummary = {
            id: tc.id,
            skillId: skill.id,
            name: skill.name,
            status: "failed",
            summary: `Permission denied: ${permDecision.reasons.join(", ")}`,
          };
          summaries.push(failSummary);
          if (stream && statusPartId) {
            stream.updateStatus(statusPartId, {
              status: "failed",
              label: `失败: ${skill.name} (权限不足)`,
            });
            // §P1-3: Update tool_use part status on permission denial
            stream.updateToolUse(tc.id, { status: "failed" });
          }
          // §5.6: Stop the tool loop on permission denial — retrying won't help
          return {
            artifacts,
            summaries,
            stop: {
              reason: "permission_denied",
              message: `工具 ${skill.name} 缺少必要权限，无法执行。`,
            },
          };
        }

        if (permDecision.requiresApproval) {
          const failSummary: ToolCallSummary = {
            id: tc.id,
            skillId: skill.id,
            name: skill.name,
            status: "failed",
            summary: `Approval required for ${skill.name}`,
          };
          summaries.push(failSummary);
          if (stream && statusPartId) {
            stream.updateStatus(statusPartId, {
              status: "failed",
              label: `需要审批: ${skill.name}`,
            });
            // §P1-3: Update tool_use part status on approval required
            stream.updateToolUse(tc.id, { status: "failed" });
          }
          // Approval-required tools should not be auto-executed —
          // they need to go through the approval path. Stop here.
          return {
            artifacts,
            summaries,
            stop: {
              reason: "permission_denied",
              message: `工具 ${skill.name} 需要审批后才能执行。`,
            },
          };
        }
      }

      // Execute via ExecutionOrchestrator
      this.deps.eventBus.emit(
        "agent.tool.started",
        { runId, toolCallId: tc.id, skillId: skill.id, name: skill.name },
        { runId, conversationId },
      );

      try {
        // §P1-4: Bridge tool progress to stream status part metadata
        const onProgress =
          stream && statusPartId
            ? (progress: {
                phase: string;
                message: string;
                percent?: number;
              }) => {
                stream!.updateStatus(statusPartId!, {
                  label: progress.message,
                  metadata: {
                    skillId: skill.id,
                    phase: progress.phase as
                      | "queued"
                      | "running"
                      | "polling"
                      | "completed",
                    progress: progress.percent,
                  },
                });
              }
            : undefined;

        const observation = await this.deps.executionOrchestrator.execute(
          {
            runId,
            context,
            intent: {
              type: "use_skill",
              confidence: 1,
              requiresPlanning: false,
              requiresTool: true,
              requiresApproval: false,
              riskLevel: "medium",
              candidateSkills: [skill.id],
              reason: "LLM function calling",
            },
            decision: {
              type: "use_tool",
              reason: `LLM called ${skill.name}`,
              toolCalls: [plannedCall],
            },
            onProgress: onProgress as
              | ((p: import("../loop-types.js").ToolExecutionProgress) => void)
              | undefined,
          },
          signal,
        );

        for (const summary of observation.toolCalls) {
          summaries.push(summary);
          this.deps.eventBus.emit(
            summary.status === "completed"
              ? "agent.tool.completed"
              : "agent.tool.failed",
            {
              runId,
              toolCallId: summary.id,
              skillId: summary.skillId,
              summary: summary.summary,
              artifacts: observation.artifacts.map((a) => a.id),
            },
            { runId, conversationId },
          );

          // Update status part and add tool result via stream (§Phase 3)
          if (stream && statusPartId) {
            const ok = summary.status === "completed";
            stream.updateStatus(statusPartId, {
              status: ok ? "completed" : "failed",
              label: ok ? `完成: ${skill.name}` : `失败: ${skill.name}`,
            });
            // §P1-3: Update tool_use part status
            stream.updateToolUse(summary.id, {
              status: ok ? "completed" : "failed",
            });
            stream.addToolResult({
              toolCallId: summary.id,
              skillId: summary.skillId,
              summary: summary.summary,
              artifactIds: observation.artifacts.map((a) => a.id),
              trust: summary.status === "completed" ? "trusted" : "untrusted",
            });
          }
        }

        artifacts.push(...observation.artifacts);

        // Emit artifact.created for each artifact
        for (const artifact of observation.artifacts) {
          this.deps.eventBus.emit(
            "agent.artifact.created",
            {
              runId,
              artifactId: artifact.id,
              name: artifact.name,
              type: artifact.type,
              version: artifact.version,
            },
            { runId, conversationId },
          );
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const failSummary: ToolCallSummary = {
          id: tc.id,
          skillId: skill.id,
          name: skill.name,
          status: "failed",
          summary: `Execution error: ${errMsg}`,
        };
        summaries.push(failSummary);
        this.deps.eventBus.emit(
          "agent.tool.failed",
          {
            runId,
            toolCallId: tc.id,
            skillId: skill.id,
            error: { code: "AGENT_TOOL_EXECUTION_FAILED", message: errMsg },
          },
          { runId },
        );
        if (stream && statusPartId) {
          stream.updateStatus(statusPartId, {
            status: "failed",
            label: `执行失败: ${skill.name}`,
          });
          // §P1-3: Update tool_use part status on execution error
          stream.updateToolUse(tc.id, { status: "failed" });
          stream.addError({
            message: errMsg,
            code: "AGENT_TOOL_EXECUTION_FAILED",
            recoverable: true,
          });
        }
      }
    }

    return { artifacts, summaries };
  }

  /**
   * Append tool call and tool result messages to the conversation.
   * This allows the LLM to see tool results in the next iteration.
   */
  private injectStreamingToolResults(
    messages: ChatMessage[],
    toolCalls: ToolCall[],
    results: { summaries: ToolCallSummary[]; artifacts: ArtifactRef[] },
  ): ChatMessage[] {
    const updated = [...messages];

    // Add assistant message with tool_calls
    updated.push({
      role: "assistant",
      content: "",
      tool_calls: toolCalls,
    });

    // Add tool result messages
    // §P0-2 + §P1-3: Use dedicated ToolResultProjection to build the richest
    // available model observation from the full tool output.
    for (const summary of results.summaries) {
      const projection = projectToolResultForModel(summary);
      updated.push({
        role: "tool",
        content: projection.modelObservation,
        tool_call_id: summary.id,
      } satisfies ChatMessage);
    }

    return updated;
  }

  /**
   * Build rich cards from artifacts for inline rendering in the chat UI.
   * Detects video/image artifacts and creates RichCardView-compatible data.
   */
  private buildStreamingRichCards(
    artifacts: ArtifactRef[],
  ): Array<import("@sunpilot/protocol").RichCardOutput> {
    const builder = new RichCardBuilder();
    builder.fromArtifacts(
      artifacts.map((a) => ({
        type: a.type as import("@sunpilot/protocol").RichCardType,
        name: a.name,
        url: (a as unknown as Record<string, unknown>).url as
          | string
          | undefined,
      })),
    );
    return builder.build();
  }
}

/** Extract the capability name portion from a fully-qualified tool id. */
function capabilityNameFromToolId(toolId: string): string | undefined {
  const separator = toolId.indexOf(":");
  return separator >= 0 ? toolId.slice(separator + 1) : undefined;
}

/**
 * §P1-3: ToolResultProjection — projects a ToolCallSummary into three facets:
 *  - displaySummary: what the user sees in the thinking section (terse)
 *  - modelObservation: what the next LLM round receives (full content)
 *  - isFinalAnswer: whether this result can serve as the final answer directly
 *
 * Priority for modelObservation:
 *  1. Explicit modelObservation (pre-computed by executor)
 *  2. Full content field (actual tool output text)
 *  3. Structured output fields (script, markdown, content, etc.)
 *  4. Summary as fallback
 */
export function projectToolResultForModel(summary: ToolCallSummary): {
  displaySummary: string;
  modelObservation: string;
  isFinalAnswer: boolean;
} {
  const statusPrefix =
    summary.status === "completed" ? "" : `[${summary.status.toUpperCase()}] `;
  const displaySummary = summary.summary;

  // Check if this result can be the final answer
  const hints = summary.metadata?.projectionHints as
    | { outputIsFinal?: boolean }
    | undefined;
  const isFinalAnswer =
    hints?.outputIsFinal === true && summary.status === "completed";

  // Build the richest model observation available
  let modelObservation: string;
  if (summary.modelObservation) {
    modelObservation = statusPrefix + summary.modelObservation;
  } else if (summary.content) {
    modelObservation = statusPrefix + summary.content;
  } else if (summary.structured && Object.keys(summary.structured).length > 0) {
    const outputFields = extractOutputFields(summary.structured);
    modelObservation = statusPrefix + outputFields;
  } else {
    modelObservation = statusPrefix + summary.summary;
  }

  // Truncate very long observations to prevent context bloat
  const MAX_OBSERVATION_CHARS = 8000;
  if (modelObservation.length > MAX_OBSERVATION_CHARS) {
    modelObservation =
      modelObservation.slice(0, MAX_OBSERVATION_CHARS) +
      `…[truncated ${modelObservation.length - MAX_OBSERVATION_CHARS} chars]`;
  }

  return { displaySummary, modelObservation, isFinalAnswer };
}

/**
 * §P0-2: Extract content-bearing fields from structured tool output
 * for use as model observation. Prevents the model from seeing only a
 * terse summary like "已完成生成短视频脚本" when the actual script is in
 * structured.script or structured.content.
 */
function extractOutputFields(structured: Record<string, unknown>): string {
  // Priority order for output content fields
  const outputKeys = [
    "script",
    "markdown",
    "content",
    "finalText",
    "text",
    "body",
    "html",
    "message",
    "output",
    "result",
    "response",
  ];
  const parts: string[] = [];

  for (const key of outputKeys) {
    const val = structured[key];
    if (typeof val === "string" && val.length > 0) {
      parts.push(`[${key}]\n${val}`);
    }
  }

  // Also include candidates/results arrays as structured data
  if (
    Array.isArray(structured.candidates) &&
    structured.candidates.length > 0
  ) {
    parts.push(`[candidates: ${structured.candidates.length} items]`);
  }
  if (Array.isArray(structured.results) && structured.results.length > 0) {
    parts.push(`[results: ${structured.results.length} items]`);
  }
  if (typeof structured.totalResults === "number") {
    parts.push(`[totalResults: ${structured.totalResults}]`);
  }
  if (typeof structured.summary === "string" && parts.length === 0) {
    parts.push(structured.summary);
  }

  return parts.length > 0 ? parts.join("\n\n") : JSON.stringify(structured);
}

function toProviderToolName(skillId: string, usedNames: Set<string>): string {
  const base = skillId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);
  const fallback = base.length > 0 ? base : "tool";
  let candidate = fallback;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${fallback.slice(0, 52)}_${suffix}`;
    suffix++;
  }
  usedNames.add(candidate);
  return candidate;
}

function maxRisk(
  left: "low" | "medium" | "high" | "critical",
  right: "low" | "medium" | "high" | "critical",
): "low" | "medium" | "high" | "critical" {
  const order = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return order[left] >= order[right] ? left : right;
}

function buildToolArgumentsHeuristic(
  context: AgentContext,
  skill?: SkillSummary,
): Record<string, unknown> {
  const message = context.currentMessage.content.trim();
  const attachments = context.currentMessage.attachments ?? [];
  const urls = extractUrls(message);

  // Find best image attachment: prefer URL, then dataUrl
  const imageAttachment =
    attachments.find(
      (attachment) =>
        Boolean(attachment.url) &&
        (attachment.type.startsWith("image/") ||
          /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(
            attachment.url ?? "",
          )),
    ) ??
    attachments.find(
      (attachment) =>
        Boolean(attachment.dataUrl) &&
        (attachment.type.startsWith("image/") ||
          /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(
            attachment.name ?? "",
          )),
    );

  const imageUrl =
    imageAttachment?.url ??
    urls.find((url) => /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(url)) ??
    urls[0];

  const isSearchLike =
    skill &&
    /search|source|lookup|find|1688|搜索|货源|同款/i.test(
      `${skill.id} ${skill.name} ${skill.description}`,
    );

  const args: Record<string, unknown> = {};
  if (isSearchLike && message.length > 0) {
    args.query = message;
  }
  if (attachments.length > 0) {
    args.attachments = attachments.map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      type: attachment.type,
      url: attachment.url,
      dataUrl: attachment.dataUrl,
      storageKey: attachment.storageKey,
      provider: attachment.provider,
    }));
  }
  if (imageAttachment) {
    fillImageArguments(args, imageAttachment);
  } else if (imageUrl) {
    args.imageUrl = imageUrl;
    args.image_url = imageUrl;
  }
  if (urls.length > 0) {
    args.urls = urls;
    args.url = urls[0];
  }
  // §Attachment fix: fall back to image attachment URL when no URL in message text
  if (!args.url && imageUrl) {
    args.url = imageUrl;
  }

  return args;
}

function extractUrls(text: string): string[] {
  return Array.from(
    text.matchAll(/https?:\/\/[^\s)）"'<>]+/gi),
    (match) => match[0],
  );
}

/**
 * Fill all image-related argument aliases from an AttachmentRef.
 *
 * Canonical fields: imageUrl (public URL), imageDataUrl (base64 fallback).
 * Compat aliases: image_url, image_data_url.
 *
 * Only overwrites undefined fields — model-provided values take precedence
 * when they are non-empty (the merge order { ...parsedArgs, ...builtArgs }
 * in executeToolCalls already ensures deterministic values win, but this
 * helper is also used in heuristic-only paths where no model args exist).
 */
function fillImageArguments(
  args: Record<string, unknown>,
  image: { url?: string; dataUrl?: string },
): void {
  if (image.url) {
    args.imageUrl = image.url;
    args.image_url = image.url;
    // Also set url as convenience alias when no explicit URL in args
    if (!args.url) args.url = image.url;
  }
  if (image.dataUrl) {
    args.imageDataUrl = image.dataUrl;
    args.image_data_url = image.dataUrl;
  }
}

/**
 * Canonicalize tool arguments — normalize alias fields to canonical names.
 *
 * LLMs may produce snake_case or camelCase variants. This normalizes known
 * aliases so downstream validation sees a consistent shape.
 */
function canonicalizeArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...args };

  // image_url → imageUrl (only if canonical field is absent)
  if (normalized.image_url !== undefined && normalized.imageUrl === undefined) {
    normalized.imageUrl = normalized.image_url;
  }
  if (
    normalized.image_data_url !== undefined &&
    normalized.imageDataUrl === undefined
  ) {
    normalized.imageDataUrl = normalized.image_data_url;
  }
  // Keep aliases too — schema validation may reference either

  return normalized;
}

// ── use_skill scoring ──────────────────────────────────────────────────

interface ScoredSkill {
  skill: SkillSummary;
  score: number;
  /** Match reasons from ToolRetriever for audit trail (§2). */
  matchReasons?: string[];
}

/**
 * Deterministic scorer for matching a user message against available skills.
 * Handles both English (substring/word-based) and Chinese (character bigram
 * overlap) matching so skills with Chinese names are correctly discovered.
 *
 * IMPORTANT: Semantic matching is now the PRIMARY layer (IntentRouter embedding
 * pipeline). This function serves as a DETERMINISTIC FALLBACK. Bigram scoring
 * is deliberately kept low-weight to avoid false positives (e.g. "商品" matching
 * "生成 Seedream 商品图" and shadowing "搜索 1688 货源").
 *
 * Scoring tiers (revised — bigrams demoted):
 *   - 1.0: skill id or capability name present verbatim (form-match)
 *   - 0.5: skill display name present verbatim (form-match, reduced from 0.8)
 *   - 0.15: strong Chinese bigram overlap (≥2 matches — tiebreaker only)
 *   - 0.10: single Chinese bigram overlap (weak hint)
 *   - 0.2: description keyword overlap ≥3 (moderate signal)
 *   - 0.1: description keyword overlap ≥1 (weak signal)
 *   - 0.4: category match
 *
 * Returns results sorted by score descending.
 */
function scoreSkills(message: string, skills: SkillSummary[]): ScoredSkill[] {
  const lower = message.toLowerCase();

  const scored = skills.map((skill) => {
    let score = 0;

    // Exact id match (e.g. "product.source.search1688")
    if (lower.includes(skill.id.toLowerCase())) {
      score = Math.max(score, 1.0);
    }

    // Capability name match (the part after the last colon)
    const capName = capabilityNameFromToolId(skill.id);
    if (capName && lower.includes(capName.toLowerCase())) {
      score = Math.max(score, 1.0);
    }

    // Skill display name match (verbatim) — reduced from 0.8 to 0.5.
    // Verbatim name match is a form-match signal but NOT a semantic one —
    // the embedding layer handles semantic matching.
    if (lower.includes(skill.name.toLowerCase())) {
      score = Math.max(score, 0.5);
    }

    // Chinese character bigram overlap — DEMOTED to tiebreaker weight.
    // Bigrams are structurally brittle: "商品" appears in both "生成Seedream商品图"
    // AND "搜索1688货源" (via user message), causing false positives.
    // Now used only as a weak hint; embedding similarity is the primary signal.
    const nameBigrams = extractBigrams(skill.name);
    const nameOverlap = nameBigrams.filter((bg) => lower.includes(bg));
    if (nameOverlap.length >= 2) {
      score = Math.max(score, 0.15); // was 0.8 — now tiebreaker only
    } else if (nameOverlap.length === 1) {
      score = Math.max(score, 0.1); // was 0.6 — now weak hint
    }

    // Description keyword overlap (handles English words and Chinese bigrams)
    const descWords = skill.description.toLowerCase().split(/\s+/);
    const matchedWords = descWords.filter(
      (w) => w.length > 1 && lower.includes(w),
    );
    const descBigrams = extractBigrams(skill.description);
    const matchedBigrams = descBigrams.filter((bg) => lower.includes(bg));

    const totalDescMatches = matchedWords.length + matchedBigrams.length;
    if (totalDescMatches >= 3) {
      score = Math.max(score, 0.2); // was 0.5 — reduced
    } else if (totalDescMatches >= 1) {
      score = Math.max(score, 0.1); // was 0.3 — reduced
    }

    // Category match
    if (lower.includes(skill.category.toLowerCase())) {
      score = Math.max(score, 0.4);
    }

    return { skill, score };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * §Schema fix: Normalize JSON Schema for LLM function calling compatibility.
 *
 * OpenAI function calling ignores anyOf/oneOf — the LLM only respects
 * top-level `required`. This converts anyOf[{required:[...]}] into
 * a flat `required: [...]` by picking the first branch's required fields.
 *
 * Also adds `additionalProperties: false` when missing, so the LLM
 * doesn't hallucinate extra params.
 */
function normalizeSchemaForLLM(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {}, additionalProperties: true };
  }

  const normalized = { ...schema };
  const anyOf = normalized.anyOf;
  const oneOf = normalized.oneOf;
  const hasDisjunction =
    (Array.isArray(anyOf) && anyOf.length > 0) ||
    (Array.isArray(oneOf) && oneOf.length > 0);

  // Remove anyOf/oneOf/allOf — LLM APIs don't understand them
  delete normalized.anyOf;
  delete normalized.oneOf;
  delete normalized.allOf;

  // If no top-level required but anyOf/oneOf exists, make all fields
  // optional to avoid biasing the LLM toward any single branch.
  if (
    hasDisjunction &&
    (!Array.isArray(normalized.required) || normalized.required.length === 0)
  ) {
    // Explicitly empty required — LLM is free to provide any combination.
    // The deterministic argument builder + checkAnyOfUnsatisfied handle
    // validation at execution time.
    normalized.required = [];

    // Append a disjunction hint to the description so the LLM knows at
    // least one of the disjunctive fields should be provided.
    const branches = (Array.isArray(anyOf) ? anyOf : []) as Array<
      Record<string, unknown>
    >;
    const altBranches = (Array.isArray(oneOf) ? oneOf : []) as Array<
      Record<string, unknown>
    >;
    const allBranches = [...branches, ...altBranches];
    const branchFields = allBranches
      .map((b) => (Array.isArray(b.required) ? b.required.join(" + ") : ""))
      .filter(Boolean);
    if (branchFields.length > 0) {
      const hint = ` [至少提供其一: ${branchFields.join(" 或 ")}]`;
      normalized.description =
        (typeof normalized.description === "string"
          ? normalized.description
          : "") + hint;
    }
  }

  // Ensure additionalProperties is set
  if (normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false;
  }

  return normalized;
}

/**
 * Extract meaningful bigrams from text.
 * Supports CJK characters (2-char bigrams), numbers/identifiers, and
 * whole English words. Skips single characters and whitespace.
 * e.g. "搜索1688货源" → ["搜索","1688","货源"]
 */
function extractBigrams(text: string): string[] {
  const result: string[] = [];
  // Extract CJK 2-char sequences
  const cjk = /[一-鿿㐀-䶿]{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = cjk.exec(text)) !== null) {
    const seg = match[0];
    for (let i = 0; i < seg.length - 1; i++) {
      result.push(seg.slice(i, i + 2));
    }
  }
  // Extract numeric/identifier tokens (e.g. "1688", "search1688")
  const tokens = /[a-z0-9]{2,}/gi;
  while ((match = tokens.exec(text)) !== null) {
    result.push(match[0].toLowerCase());
  }
  return result;
}

/**
 * Derive ToolCallHistoryEntry[] from context tool results.
 * Extracts skillId and status from tool result entries so the ToolRetriever
 * can apply success/failure weighting at runtime without depending on
 * pre-constructed history from the composition root.
 *
 * Entries without a resolvable skillId are filtered out — a UUID
 * toolCallId is not meaningful for skill-to-skill weighting.
 */
function deriveRecentHistory(
  toolResults: Array<{
    toolCallId: string;
    summary: string;
    content?: string;
    status: string;
    name?: string;
    skillId?: string;
    structured?: Record<string, unknown>;
  }>,
): Array<{
  skillId: string;
  status: "completed" | "failed" | "timeout" | "rejected";
  timestamp: string;
}> {
  return toolResults
    .filter((tr) => tr.status !== "pending" && tr.status !== "running")
    .map((tr) => {
      // Resolve skillId: prefer explicit field, then structured metadata.
      // Skip entries that fall back to a UUID toolCallId — that isn't
      // useful for the retriever's skill-level weighting.
      const resolvedSkillId =
        tr.skillId ??
        (tr.name?.includes(":")
          ? tr.name.slice(0, tr.name.lastIndexOf(":"))
          : undefined) ??
        ((tr.structured as Record<string, unknown> | undefined)?.skillId as
          | string
          | undefined);
      if (!resolvedSkillId) return null;

      // Map tool status to history status. Unknown statuses default to
      // "failed" — it's safer to de-prioritize than to assume success.
      const historyStatus =
        tr.status === "completed"
          ? ("completed" as const)
          : tr.status === "failed" || tr.status === "timeout"
            ? (tr.status as "failed" | "timeout")
            : tr.status === "cancelled"
              ? ("rejected" as const)
              : ("failed" as const);

      return {
        skillId: resolvedSkillId,
        status: historyStatus,
        timestamp: new Date().toISOString(),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

/** Clamp a value to [0, 1] with a default for NaN/undefined. */
function clampConfidence(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

/** Summarize tool arguments for inline preview display (truncates long values). */
function summarizeForPreview(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const preview: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 80) {
      preview[key] = value.slice(0, 80) + "...";
    } else if (Array.isArray(value) && value.length > 3) {
      preview[key] = `[${value.length} items]`;
    } else {
      preview[key] = value;
    }
  }
  return preview;
}

/** Attach trace metadata to a ToolDecision from DecisionMetadata (§P2). */
function attachTrace(
  decision: ToolDecision,
  meta?: DecisionMetadata,
): ToolDecision {
  if (meta) {
    decision.decisionPath = meta.decisionPath;
    if (meta.retrievalMetadata) {
      decision.retrievalTopK = meta.retrievalMetadata.topK;
      decision.retrievalCandidateCount =
        meta.retrievalMetadata.candidates?.length;
      decision.retrievalFallback = meta.retrievalMetadata.fallbackUsed;
    }
  }
  return decision;
}

// ── Internal Types ─────────────────────────────────────────────────────

interface ToolCallAccumulator {
  index: number;
  id: string;
  type: "function";
  functionName: string;
  functionArguments: string;
}
