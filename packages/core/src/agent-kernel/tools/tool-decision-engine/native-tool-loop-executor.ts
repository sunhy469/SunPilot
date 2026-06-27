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
import { StreamingToolCallExecutor } from "./streaming-tool-call-executor.js";

export class NativeToolLoopExecutor {
  private readonly toolCallExecutor: StreamingToolCallExecutor;

  constructor(private readonly deps: ToolDecisionEngineDeps) {
    this.toolCallExecutor = new StreamingToolCallExecutor(deps);
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
      /** Skill IDs pre-matched by ToolSelector. When provided,
       *  executeStreaming() uses these directly instead of
       *  independently re-retrieving tools. */
      toolSkillIds?: string[];
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
    const { runId, conversationId, context, intent, plan } = input;
    const toolSkillIds = input.toolSkillIds;
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

      // 3. Get candidate tools (§P0-3: track timing)
      // Prefer ToolSelector's pre-matched skills when available.
      // Otherwise fall back to independent retrieval + topK filtering.
      const retrievalStart = Date.now();
      let toolRetrievalMs: number;
      let tools: ToolDefinition[];
      let nameMap: Map<string, string>;

      if (toolSkillIds && toolSkillIds.length > 0) {
        // Use ToolSelector's pre-matched skills — bypass independent retrieval
        const selectedSkills = allSkills.filter((s) => toolSkillIds.includes(s.id));
        const syntheticRetrieval: ToolRetrievalResult = {
          tools: selectedSkills.map((skill) => ({
            skill,
            score: 1.0,
            matchReasons: ["ToolSelector: pre-matched skill"],
          })),
          topK: selectedSkills.length,
          fallbackUsed: false,
          topKReason: "ToolSelector pre-matched skills",
        };
        ({ tools, nameMap } = buildStreamingToolDefinitions(
          syntheticRetrieval,
          intent,
          selectedSkills.length, // overrideLimit — include all selected skills
        ));
        toolRetrievalMs = Date.now() - retrievalStart;
      } else {
        // Backward-compatible path: independent retrieval + intent-based topK
        const retrieval = await this.retrieveStreamingTools(
          context,
          intent,
          allSkills,
          input.permissionMode,
        );
        toolRetrievalMs = Date.now() - retrievalStart;
        ({ tools, nameMap } = buildStreamingToolDefinitions(retrieval, intent));
      }

      // 4. Streaming loop: interleave text + tool calls
      let iteration = 0;
      let currentMessages = messages;
      let summarizeStatusId: string | undefined;
      // §P0-3: Aggregate timing across tool execution rounds
      let totalToolExecutionMs = 0;
      let firstRoundFirstTokenMs = 0;
      let finalRoundFirstTokenMs = 0;
      // §6.2: Dynamic iteration cap based on intent + plan complexity.
      // Simple tasks get the default 5; complex/long-running intents and
      // multi-step plans get more headroom so they don't get truncated.
      const maxIterations = computeMaxIterations(intent, plan);

      while (iteration < maxIterations) {
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
        // §4.6: Use stable serialization so key order doesn't cause missed dups
        let duplicateBlocked = false;
        for (const tc of result.toolCalls) {
          const skillId = nameMap.get(tc.function.name) ?? tc.function.name;
          const signature = `${skillId}:${stableStringifyArgs(tc.function.arguments)}`;
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
        const toolResults = await this.toolCallExecutor.execute(
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
          .map((s) => projectToolResultForModel(s, context.limits.maxTokens))
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
        currentMessages = injectStreamingToolResults(
          currentMessages,
          result.toolCalls,
          toolResults,
          context.limits.maxTokens,
        );

        // §6.3: Plan-driven iteration validation — when a plan exists,
        // check if all tool-type steps have been satisfied by executed
        // tool calls. If so, inject a hint guiding the LLM to summarize
        // and stop calling more tools. This prevents the LLM from
        // continuing to call tools after the plan is complete.
        if (plan && plan.steps.some((s) => s.type === "tool" && s.skillId)) {
          const executedSkillIds = new Set(
            allToolCallSummaries.map((s) => s.skillId),
          );
          const planToolSteps = plan.steps.filter(
            (s) => s.type === "tool" && s.skillId,
          );
          const allPlanToolsExecuted = planToolSteps.every((step) =>
            executedSkillIds.has(step.skillId!),
          );
          if (allPlanToolsExecuted) {
            // Inject a system hint telling the LLM the plan is complete
            currentMessages = [
              ...currentMessages,
              {
                role: "system" as const,
                content:
                  "All planned tool steps have been executed. Summarize the results for the user and do not call additional tools unless absolutely necessary.",
              },
            ];
          }
        }

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
      // §4.3: MARKDOWN_RESPONSE_POLICY only in non-slim (final answer) mode.
      // First tool round doesn't need formatting instructions.
      ...(slim ? [] : [MARKDOWN_RESPONSE_POLICY]),
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

    // §6.5: Throttle agent.model.delta events to reduce WebSocket load.
    const deltaThrottle = new DeltaThrottle((delta) => {
      this.deps.eventBus.emit(
        "agent.model.delta",
        { runId, modelCallId, delta },
        { runId, conversationId },
      );
    }, 50);

    // §P0: Buffer for suppressing <FunctionCallBegin> text from frontend.
    // Doubao occasionally outputs tool calls as text tags instead of
    // native tool_calls. We suppress these from the stream and parse
    // them into tool calls after the turn completes.
    let bufferingFunctionCall = false;
    let functionCallBuffer = "";

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

          // §P0: Detect and suppress textual function call blocks.
          // When the model outputs <FunctionCallBegin>, buffer instead of
          // streaming — so users never see the hallucinated text format.
          if (chunk.delta.includes("<FunctionCallBegin>") || bufferingFunctionCall) {
            bufferingFunctionCall = true;
            functionCallBuffer += chunk.delta;
            textContent += chunk.delta; // still capture for parsing
            if (chunk.delta.includes("<FunctionCallEnd>")) {
              bufferingFunctionCall = false;
            }
          } else {
            // §Phase 2a: Lazy text part creation — only create when the
            // model actually produces text, avoiding empty text parts.
            // §P0-1: Pass textPartRole so frontend can classify stably.
            if (stream && !lazyTextPartId) {
              const textPart = stream.startTextPart(textPartRole);
              lazyTextPartId = textPart.id;
            }

            textContent += chunk.delta;

            // Route deltas through stream when available (§Phase 3)
            if (stream && lazyTextPartId) {
              stream.appendText(lazyTextPartId, chunk.delta);
            }

            // §6.5: Throttled event emission (see deltaThrottle above)
            deltaThrottle.push(chunk.delta);
          }
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

      // §6.5: Flush any remaining buffered delta before emitting model.completed
      deltaThrottle.flush();

      this.deps.eventBus.emit(
        "agent.model.completed",
        { runId, modelCallId, outputTokens: textContent.length },
        { runId, conversationId },
      );
    } catch (error) {
      // §6.5: Flush buffered delta on error so partial text isn't lost
      deltaThrottle.flush();
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

    const textualToolCalls = parseTextualFunctionCalls(textContent, tools);

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

    // §P0: Fall back to textual tool calls when native tool_calls are empty
    // but the model emitted a well-formed <FunctionCallBegin> block.
    const effectiveToolCalls = toolCalls.length > 0 ? toolCalls : textualToolCalls;

    return { textContent, toolCalls: effectiveToolCalls, textPartId: lazyTextPartId, firstTokenMs };
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
        type: a.type,
        name: a.name,
        url: (a as unknown as Record<string, unknown>).url as
          | string
          | undefined,
      })),
    );
    return builder.build();
  }
}
