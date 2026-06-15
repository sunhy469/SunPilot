import type { AgentEventBus } from "../agent-event-bus.js";
import type {
  AgentContext,
  AgentLoopInput,
  AgentObservation,
  AgentReflection,
  IntentRouter,
  ResponseComposer as ResponseComposerInterface,
} from "../loop-types.js";
import type { ComposeResult, ResponseComposerDeps } from "./response-types.js";

/**
 * ResponseComposer — 生成最终的助手回复。
 *
 * 两种模式（架构文档 §18）：
 *   1. composeDirect      — no_tool 路径：将 AgentContext 组装为 ChatMessage 数组后
 *                            调用 LLM 流式生成纯文本回复
 *   2. composeFromObservation — use_tool 路径：将工具执行结果和反思总结格式化后
 *                               注入上下文，调用 LLM 生成自然语言总结
 *   3. composeClarification — ask_clarification 路径：直接返回澄清问题，不调用 LLM
 *
 * 所有模式都通过 AgentEventBus 流式输出 delta 事件（agent.response.delta），
 * 并在完成后持久化最终消息。
 */
export class ResponseComposer implements ResponseComposerInterface {
  constructor(private readonly deps: ResponseComposerDeps) {}

  async composeDirect(
    input: {
      input: AgentLoopInput;
      context: AgentContext;
      intent: ReturnType<IntentRouter["route"]> extends Promise<infer T>
        ? T
        : never;
      plan?: import("../loop-types.js").AgentPlan;
    },
    signal: AbortSignal,
  ): Promise<ComposeResult> {
    const messages = this.buildMessages(input.context);
    return this.streamAndSave(
      messages,
      input.input.runId,
      input.input.conversationId,
      signal,
      undefined,
      input.context.contextSnapshot,
    );
  }

  async composeFromObservation(
    input: {
      input: AgentLoopInput;
      context: AgentContext;
      observation: AgentObservation;
      reflection?: AgentReflection;
    },
    signal: AbortSignal,
  ): Promise<ComposeResult> {
    // Build a summary prompt from the observation with reliability constraints.
    // Use projectToolResult for structured results to avoid dumping full JSON.
    const toolSummaries = input.observation.toolCalls
      .map((tc) => {
        let resultText = tc.summary;
        if (tc.structured) {
          const projected = projectToolResult(tc.structured, {
            maxCandidates: 5,
            fields: ["id", "title", "price", "sales", "detailUrl", "estimatedProfitRmb"],
          });
          resultText = JSON.stringify(projected, null, 2);
        }
        return `Tool: ${tc.name} (${tc.skillId})\nStatus: ${tc.status}\nResult: ${resultText}`;
      })
      .join("\n\n");
    const reflectionSummary = input.reflection
      ? `\n\nReflection:\nGoal achieved: ${input.reflection.goalAchieved ? "yes" : "no"}\nSummary: ${input.reflection.summary}\nNext action: ${input.reflection.nextAction ?? "respond"}${input.reflection.stopReason ? `\nStop reason: ${input.reflection.stopReason}` : ""}${input.reflection.stopReason === "max_iterations" ? "\nIMPORTANT: You have reached the maximum number of tool iterations. Inform the user what was accomplished and what remains to be done." : ""}`
      : "";

    // Inject tool result reliability constraints
    const reliabilityRules = TOOL_RESULT_RELIABILITY_RULES.map(
      (r) => `- ${r}`,
    ).join("\n");

    const observationContext = [
      ...input.context.messages,
      {
        role: "system" as const,
        content: `The following tools were executed. Summarize the results for the user:\n\n${toolSummaries}${reflectionSummary}\n\nIMPORTANT — Tool Result Reliability Rules:\n${reliabilityRules}`,
      },
    ];

    // Add the original user message (with attachment URLs if present)
    let userContent = input.input.message;
    const attachments = input.input.attachments;
    if (attachments && attachments.length > 0) {
      const attachmentLines = attachments.map(
        (a) => `- ${a.name} (${a.type}): ${a.url || "(local file, no URL)"}`,
      );
      userContent += "\n\nAttachments:\n" + attachmentLines.join("\n");
    }
    observationContext.push({
      role: "user" as const,
      content: userContent,
    });

    // Build provenance metadata linking response to tool calls.
    // Extract real candidate IDs from structured results when available.
    const toolCallIds = input.observation.toolCalls.map((tc) => tc.id);
    const candidateIds: string[] = [];
    for (const tc of input.observation.toolCalls) {
      if (tc.structured) {
        const candidates = (tc.structured.candidates ??
          tc.structured.results) as Array<{ id?: string }> | undefined;
        if (Array.isArray(candidates)) {
          for (const c of candidates.slice(0, 5)) {
            if (c.id) candidateIds.push(String(c.id));
          }
        }
      }
    }
    const provenanceMetadata = buildResponseProvenance({
      toolCallIds,
      candidateIds: candidateIds.length > 0 ? candidateIds : undefined,
    });

    return this.streamAndSave(
      observationContext.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      input.input.runId,
      input.input.conversationId,
      signal,
      provenanceMetadata,
      input.context.contextSnapshot,
    );
  }

  async composeClarification(input: {
    input: AgentLoopInput;
    question: string;
    reason: string;
  }): Promise<ComposeResult> {
    const messageId = `msg_${crypto.randomUUID()}`;
    const { runId, conversationId } = input.input;

    this.deps.eventBus.emit(
      "agent.response.started",
      { runId, conversationId, messageId },
      { runId, conversationId },
    );
    this.deps.eventBus.emit(
      "agent.clarification.requested",
      {
        runId,
        conversationId,
        messageId,
        question: input.question,
        reason: input.reason,
      },
      { runId, conversationId },
    );
    this.deps.eventBus.emit(
      "agent.response.delta",
      {
        runId,
        conversationId,
        messageId,
        delta: input.question,
      },
      { runId, conversationId },
    );

    await this.deps.saveMessage({
      id: messageId,
      conversationId,
      role: "assistant",
      content: input.question,
      runId,
    });

    return { messageId, content: input.question };
  }

  private async streamAndSave(
    messages: Array<{ role: string; content: string }>,
    runId: string,
    conversationId: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
    contextSnapshot?: AgentContext["contextSnapshot"],
  ): Promise<ComposeResult> {
    const messageId = `msg_${crypto.randomUUID()}`;
    const modelCallId = `model_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const inputTokens = estimateTokens(
      messages.map((message) => message.content).join("\n"),
    );
    let content = "";

    try {
      this.deps.eventBus.emit(
        "agent.response.started",
        { runId, conversationId, messageId },
        { runId, conversationId },
      );
      await this.deps.modelCalls?.create({
        id: modelCallId,
        runId,
        provider: this.deps.llm.id ?? "unknown",
        model: this.deps.llm.model ?? "unknown",
        purpose: "response.compose",
        inputTokens,
        status: "pending",
        metadata: contextSnapshot
          ? { context: contextSnapshot }
          : undefined,
      });
      this.deps.eventBus.emit(
        "agent.model.started",
        {
          runId,
          modelCallId,
          provider: this.deps.llm.id ?? "unknown",
          model: this.deps.llm.model ?? "unknown",
        },
        { runId, conversationId },
      );

      for await (const chunk of this.deps.llm.streamChat({
        messages: messages.map((m) => ({
          role: m.role as "system" | "user" | "assistant",
          content: m.content,
        })),
      })) {
        if (signal.aborted) {
          throw Object.assign(new Error("Response generation aborted"), {
            code: "AGENT_RUN_CANCELLED",
            category: "run_state",
          });
        }
        content += chunk.delta;
        this.deps.eventBus.emit(
          "agent.model.delta",
          {
            runId,
            modelCallId,
            delta: chunk.delta,
          },
          { runId, conversationId },
        );
        this.deps.eventBus.emit(
          "agent.response.delta",
          {
            runId,
            conversationId,
            messageId,
            delta: chunk.delta,
          },
          { runId, conversationId },
        );
      }

      await this.deps.modelCalls?.updateStatus(modelCallId, "completed", {
        inputTokens,
        outputTokens: estimateTokens(content),
        latencyMs: Date.now() - startedAt,
      });
      this.deps.eventBus.emit(
        "agent.model.completed",
        {
          runId,
          modelCallId,
          inputTokens,
          outputTokens: estimateTokens(content),
        },
        { runId, conversationId },
      );

      // Save the final message with provenance metadata
      await this.deps.saveMessage({
        id: messageId,
        conversationId,
        role: "assistant",
        content,
        runId,
        metadata,
      });
    } catch (error) {
      const normalizedError = normalizeModelError(error);
      await this.deps.modelCalls?.updateStatus(
        modelCallId,
        signal.aborted ? "cancelled" : "failed",
        {
          inputTokens,
          outputTokens: estimateTokens(content),
          latencyMs: Date.now() - startedAt,
          error: normalizedError,
        },
      );
      this.deps.eventBus.emit(
        "agent.model.failed",
        {
          runId,
          modelCallId,
          error: normalizedError,
        },
        { runId, conversationId },
      );
      // Save partial message on error
      if (content.length > 0) {
        try {
          await this.deps.saveMessage({
            id: messageId,
            conversationId,
            role: "assistant",
            content: content + "\n\n[Response interrupted]",
            runId,
          });
        } catch {
          // Best effort
        }
      }
      throw error;
    }

    return { messageId, content };
  }

  /**
   * Build messages array from AgentContext for the LLM call.
   * Includes attachment URLs so the LLM can reference uploaded files.
   */
  private buildMessages(
    context: AgentContext,
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [];

    // System prompt: persona + rules + safety
    const systemParts = [context.system.persona];

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

    messages.push({
      role: "system",
      content: systemParts.join("\n"),
    });

    // Memories as system context
    if (context.memories.length > 0) {
      const memoryLines = context.memories.map(
        (m) =>
          `[${m.type}] ${m.title}: ${m.content} (confidence: ${m.confidence})`,
      );
      messages.push({
        role: "system",
        content: "Relevant memories:\n" + memoryLines.join("\n"),
      });
    }

    // Skill catalog as system context
    if (context.availableSkills.length > 0) {
      const skillLines = context.availableSkills.map(
        (s) => `- ${s.name} (${s.id}): ${s.description}`,
      );
      messages.push({
        role: "system",
        content: "Available tools:\n" + skillLines.join("\n"),
      });
    }

    // Conversation history — include attachment URLs for historical messages
    for (const msg of context.messages) {
      const attachments = msg.metadata?.attachments as
        | Array<{
            id: string;
            name: string;
            type: string;
            url?: string;
          }>
        | undefined;
      const content = appendAttachmentLines(msg.content, attachments);
      messages.push({ role: msg.role, content });
    }

    // Current user message — include attachment URLs so the LLM can see them
    const { content, attachments } = context.currentMessage;
    const userContent = appendAttachmentLines(content, attachments);
    messages.push({ role: "user", content: userContent });

    return messages;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Append attachment reference lines to message content.
 * Format: "Attachments:\n- name (type): url"
 * This ensures the LLM can see historical attachment URLs for context.
 */
function appendAttachmentLines(
  content: string,
  attachments?: Array<{
    id?: string;
    name: string;
    type: string;
    url?: string;
  }>,
): string {
  if (!attachments || attachments.length === 0) return content;
  const lines = attachments.map(
    (a) => `- ${a.name} (${a.type}): ${a.url || "(local file, no URL)"}`,
  );
  return content + "\n\nAttachments:\n" + lines.join("\n");
}

/**
 * Tool result reliability constraints injected into the system prompt
 * when the assistant is summarizing tool results. Prevents the LLM from
 * fabricating prices, modifying links, reordering candidates, or adding
 * data not present in the tool output.
 */
export const TOOL_RESULT_RELIABILITY_RULES = [
  "Only reference fields that exist in the tool results. Do not invent prices, sales figures, ratings, or links.",
  "Do not reorder, skip, or selectively present tool result candidates. Present them in the order returned.",
  "When displaying prices, URLs, or IDs, copy them exactly from the tool result. Never modify or approximate.",
  "Clearly separate tool-returned facts from your own analysis or suggestions.",
  "If tool results contain structured data (tables, lists), preserve the structure.",
];

/**
 * Build provenance metadata for an assistant message that references tool results.
 * Each displayed item maps back to its source toolCallId and candidate id.
 */
export function buildResponseProvenance(input: {
  toolCallIds: string[];
  candidateIds?: string[];
}): Record<string, unknown> {
  return {
    provenance: {
      toolCallIds: input.toolCallIds,
      items: (input.candidateIds ?? []).map((candidateId, _index) => ({
        source: "tool_result",
        toolCallId: input.toolCallIds[0] ?? "unknown",
        candidateId,
      })),
    },
  };
}

/**
 * Project a tool result to only include the most important fields,
 * limiting candidate count and selecting specific display fields.
 * Prevents full JSON blobs from entering the LLM prompt.
 */
export function projectToolResult(
  toolResult: Record<string, unknown>,
  options?: {
    maxCandidates?: number;
    fields?: string[];
  },
): Record<string, unknown> {
  const maxCandidates = options?.maxCandidates ?? 5;
  const fields = options?.fields ?? [
    "id",
    "title",
    "price",
    "sales",
    "detailUrl",
    "estimatedProfitRmb",
  ];

  const candidates = Array.isArray(toolResult.candidates)
    ? toolResult.candidates.slice(0, maxCandidates)
    : Array.isArray(toolResult.results)
      ? toolResult.results.slice(0, maxCandidates)
      : undefined;

  const projected: Record<string, unknown> = {
    totalResults: toolResult.totalResults ?? candidates?.length ?? 0,
  };

  if (candidates) {
    projected.candidates = candidates.map((item: Record<string, unknown>) => {
      const picked: Record<string, unknown> = {};
      for (const field of fields!) {
        if (field in item) picked[field] = item[field];
      }
      // Always include id if present
      if (item.id && !("id" in picked)) picked.id = item.id;
      return picked;
    });
  }

  if (toolResult.summary) {
    projected.summary = toolResult.summary;
  }

  if (toolResult.error) {
    projected.error = toolResult.error;
  }

  return projected;
}

function normalizeModelError(error: unknown): {
  code: string;
  message: string;
  category?: string;
  retryable?: boolean;
} {
  if (error instanceof Error) {
    const details = error as {
      code?: string;
      category?: string;
      retryable?: boolean;
    };
    return {
      code: details.code ?? "AGENT_MODEL_CALL_FAILED",
      message: error.message,
      category: details.category,
      retryable: details.retryable,
    };
  }
  return {
    code: "AGENT_MODEL_CALL_FAILED",
    message: String(error),
  };
}
