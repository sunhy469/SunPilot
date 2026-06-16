import type { LlmProvider } from "../../llm/llm.provider.js";
import type {
  AgentContext,
  AgentPlan,
  AgentObservation,
  PlannedToolCall,
  RoutedIntent,
  ToolDecision,
  ToolDecisionEngine as ToolDecisionEngineInterface,
} from "../loop-types.js";
import { INTENT_SKILL_MAP, type SkillSummary } from "./tool-types.js";
import type { ToolArgumentBuilder } from "./tool-argument-builder.js";
import type { ToolRetriever, ToolCallHistoryEntry } from "./tool-retriever.js";
import type { EmbeddingService } from "../context/embedding-service.js";

// ── Decision metadata (§P1-4) ─────────────────────────────────────────────

/** Audit metadata recorded on each PlannedToolCall for debugging tool selection. */
export interface DecisionMetadata {
  /** Which layer made the final selection. */
  decisionPath: "plan" | "intent_match" | "priority" | "deterministic_scorer" | "llm_semantic" | "scorer_fallback" | "intent_skill_map" | "no_tool";
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
  /** Recent tool call history for success/failure weighting. */
  recentHistory?: ToolCallHistoryEntry[];
  /** Current permission mode for safety-aware scoring. */
  permissionMode?: "ask" | "auto" | "full";
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
    const { context, intent, plan, previousObservation, prioritySkills } = input;

    // ── Priority lane: reflection-suggested tools ──────────────────────
    // When the reflection engine suggests specific tools (e.g. search→detail
    // chain), try these first with their argumentsHint before falling back
    // to normal candidate matching.
    if (prioritySkills && prioritySkills.length > 0 && !plan) {
      const availableSkills = await this.listEnabledSkills();
      const priorityCalls: PlannedToolCall[] = [];

      for (const ps of prioritySkills) {
        const skill = availableSkills.find(
          (s) => s.id === ps.skillId || capabilityNameFromToolId(s.id) === ps.skillId,
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
        const skill = availableSkills.find(
          (item) => item.id === step.skillId,
        );
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
              built.call.riskLevel === "high" || built.call.riskLevel === "critical";
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
      let retrievalMetaForAudit: DecisionMetadata["retrievalMetadata"] | undefined;

      // Layer 1.5: ToolRetriever multi-layer retrieval (§2 of architecture next steps)
      if (this.deps.toolRetriever) {
        try {
          const recentHistory = deriveRecentHistory(context.toolResults);

          const retrievalResult = await this.deps.toolRetriever.retrieve({
            query: context.currentMessage.content,
            intent,
            availableSkills,
            embeddingService: this.deps.embeddingService,
            recentHistory:
              this.deps.recentHistory ?? recentHistory,
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

          if (scored.length === 0 || (retrievalResult.fallbackUsed && scored[0]!.score < 0.1)) {
            scored = scoreSkills(context.currentMessage.content, availableSkills);
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
      if (!best || best.score <= 0) {
        // No match at all → fall through to INTENT_SKILL_MAP below
      } else {
        const runnerUp = scored[1];

        // Layer 2: High-confidence deterministic — skip LLM entirely
        const isClearWinner =
          best.score >= 0.8 &&
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
          return {
            type: "ask_clarification",
            question: `找到多个匹配技能（${candidates}），请问要使用哪个？`,
            reason: `Multiple skills match with close scores (top: ${best.score.toFixed(2)}, runner-up: ${runnerUp.score.toFixed(2)})`,
          };
        }

        // Layer 3: LLM semantic selection — pass top-5 candidates to LLM
        if (this.deps.llm) {
          const topCandidates = scored.filter((s) => s.score > 0).slice(0, 5);
          try {
            const selectedSkillId = await this.selectSkillWithLlm(
              context.currentMessage.content,
              topCandidates.map((s) => s.skill),
            );
            if (selectedSkillId) {
              const selected = topCandidates.find(
                (s) => s.skill.id === selectedSkillId,
              );
              if (selected) {
                const decisionMeta: DecisionMetadata = {
                  decisionPath: "llm_semantic",
                  llmSelectionUsed: true,
                  retrievalMetadata: retrievalMetaForAudit,
                };
                return this.buildUseToolDecision(
                  [selected.skill],
                  `LLM selected: ${selectedSkillId}`,
                  decisionMeta,
                  context,
                  previousObservation,
                  signal,
                );
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

    const toolCalls = built
      .filter((b) => b.call !== null)
      .map((b) => b.call!);

    // If ALL tools failed with missing params, ask clarification (§P0-1 fix)
    if (toolCalls.length === 0 && clarifications.length > 0) {
      return {
        type: "ask_clarification",
        question: clarifications.join(" "),
        reason: `All ${skills.length} skill(s) require missing parameters: ${clarifications.join("; ")}`,
      };
    }

    return {
      type: "use_tool",
      reason,
      toolCalls,
    };
  }

  /**
   * Use an LLM to select the best-matching skill from a shortlist
   * of top-N candidates. Only called when the deterministic scorer
   * can't confidently pick a single winner.
   *
   * Token optimisation: only the top-5 candidates are sent to the LLM,
   * avoiding the cost of sending the full skill catalog.
   */
  private async selectSkillWithLlm(
    userMessage: string,
    candidates: SkillSummary[],
  ): Promise<string | null> {
    if (!this.deps.llm || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0]!.id;

    const skillOptions = candidates
      .map(
        (s, i) =>
          `${i + 1}. ${s.id}\n   Name: ${s.name}\n   Description: ${s.description}`,
      )
      .join("\n\n");

    const prompt = `Select the BEST tool for this user request.

User: "${userMessage}"

Candidate tools:
${skillOptions}

Respond with ONLY the tool ID (e.g. "jaderoad:product.source.search1688") or "none" if none match.`;

    const messages = [{ role: "user" as const, content: prompt }];
    let response = "";

    for await (const chunk of this.deps.llm.streamChat({ messages })) {
      response += chunk.delta;
    }

    const selected = response.trim();
    if (selected === "none") return null;

    // Validate the response is one of the candidate IDs
    const valid = candidates.find((s) => s.id === selected);
    return valid ? valid.id : null;
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
    const { arguments: args, sources, missing } =
      await this.buildToolArgumentsAsync(
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

/** Extract the capability name portion from a fully-qualified tool id. */
function capabilityNameFromToolId(toolId: string): string | undefined {
  const separator = toolId.indexOf(":");
  return separator >= 0 ? toolId.slice(separator + 1) : undefined;
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
  const imageAttachment = attachments.find(
    (attachment) =>
      Boolean(attachment.url) &&
      (attachment.type.startsWith("image/") ||
        /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(attachment.url ?? "")),
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
      storageKey: attachment.storageKey,
      provider: attachment.provider,
    }));
  }
  if (imageUrl) {
    args.imageUrl = imageUrl;
    args.image_url = imageUrl;
  }
  if (urls.length > 0) {
    args.urls = urls;
    args.url = urls[0];
  }

  return args;
}

function extractUrls(text: string): string[] {
  return Array.from(
    text.matchAll(/https?:\/\/[^\s)）"'<>]+/gi),
    (match) => match[0],
  );
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
 * Scoring tiers:
 *   - 1.0: skill id or capability name present verbatim
 *   - 0.8: skill display name present verbatim OR strong Chinese bigram overlap
 *   - 0.5: description keywords (English words or Chinese bigrams) overlap
 *   - 0.2: any single keyword / bigram match (weak signal)
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

    // Skill display name match (verbatim)
    if (lower.includes(skill.name.toLowerCase())) {
      score = Math.max(score, 0.8);
    }

    // Chinese character bigram overlap between message and skill name.
    // "搜一下这件衣服的货源" vs "搜索1688货源" → bigrams ["搜索","1688","货源","搜索1688","1688货源"]
    // overlap: ["货源"] → 1 match → score boost.
    const nameBigrams = extractBigrams(skill.name);
    const nameOverlap = nameBigrams.filter((bg) => lower.includes(bg));
    if (nameOverlap.length >= 2) {
      score = Math.max(score, 0.8);
    } else if (nameOverlap.length === 1) {
      score = Math.max(score, 0.6);
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
      score = Math.max(score, 0.5);
    } else if (totalDescMatches >= 1) {
      score = Math.max(score, 0.3);
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
        (tr.structured as Record<string, unknown> | undefined)?.skillId as
          | string
          | undefined;
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
