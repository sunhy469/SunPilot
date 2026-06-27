import type { LlmProvider } from "../../../llm/llm.provider.js";
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
} from "../../loop-types.js";
import { INTENT_SKILL_MAP, type SkillSummary } from "../tool-types.js";
import type { ToolArgumentBuilder } from "../tool-argument-builder.js";
import type {
  ToolRetriever,
  ToolRetrievalResult,
  ToolCallHistoryEntry,
} from "../tool-retriever.js";
import type { EmbeddingService } from "../../context/embedding-service.js";
import type { AgentEventBus } from "../../agent-event-bus.js";
import { DeltaThrottle } from "../../agent-event-bus.js";
import type { ModelRouter } from "../../model-router.js";
import { checkAnyOfUnsatisfied } from "../tool-schema-utils.js";
import { RichCardBuilder } from "../rich-card-builder.js";
import { MARKDOWN_RESPONSE_POLICY } from "../markdown-response-policy.js";
import {
  buildStreamingToolDefinitions,
} from "./tool-definition-builder.js";
import {
  buildToolArgumentsHeuristic,
  canonicalizeArgs,
} from "./tool-argument-normalizer.js";
import {
  injectStreamingToolResults,
  projectToolResultForModel,
} from "./tool-result-projector.js";
import {
  attachTrace,
  capabilityNameFromToolId,
  clampConfidence,
  computeMaxIterations,
  deriveRecentHistory,
  maxRisk,
  scoreSkills,
  stableStringifyArgs,
  summarizeForPreview,
} from "./selection-utils.js";
import { parseTextualFunctionCalls } from "./textual-function-call-parser.js";
import type {
  DecisionMetadata,
  LlmToolDecision,
  ScoredSkill,
  ToolCallAccumulator,
  ToolLoopStopReason,
} from "./types.js";

import type {
  ChatMessage,
  ToolCall,
  ToolDefinition,
} from "../../../llm/llm.types.js";
import type { ToolDecisionEngineDeps } from "../tool-decision-engine.js";

export class ToolSelector {
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
}
