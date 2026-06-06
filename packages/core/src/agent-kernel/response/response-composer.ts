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
 * ResponseComposer — generates the final assistant response.
 *
 * Two modes per architecture doc §18:
 *   1. composeDirect — for no_tool decisions (pure LLM response)
 *   2. composeFromObservation — for tool-based decisions (LLM summarizes results)
 *
 * Both modes stream deltas via AgentEventBus and persist the final message.
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
    const messages = this.buildMessages(input.context, input.input.message);
    return this.streamAndSave(
      messages,
      input.input.runId,
      input.input.conversationId,
      signal,
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
    // Build a summary prompt from the observation
    const toolSummaries = input.observation.toolCalls
      .map(
        (tc) =>
          `Tool: ${tc.name} (${tc.skillId})\nStatus: ${tc.status}\nResult: ${tc.summary}`,
      )
      .join("\n\n");
    const reflectionSummary = input.reflection
      ? `\n\nReflection:\nGoal achieved: ${input.reflection.goalAchieved ? "yes" : "no"}\nSummary: ${input.reflection.summary}\nNext action: ${input.reflection.nextAction ?? "respond"}`
      : "";

    const observationContext = [
      ...input.context.messages,
      {
        role: "system" as const,
        content: `The following tools were executed. Summarize the results for the user:\n\n${toolSummaries}${reflectionSummary}`,
      },
    ];

    // Add the original user message as the final message
    observationContext.push({
      role: "user" as const,
      content: input.input.message,
    });

    return this.streamAndSave(
      observationContext.map((m) => ({
        role: m.role,
        content: m.content,
      })),
      input.input.runId,
      input.input.conversationId,
      signal,
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

      // Save the final message
      await this.deps.saveMessage({
        id: messageId,
        conversationId,
        role: "assistant",
        content,
        runId,
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
   * Converts the rich AgentContext into the flat ChatMessage format.
   */
  private buildMessages(
    context: AgentContext,
    currentMessage: string,
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

    // Conversation history
    for (const msg of context.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    // Current user message
    messages.push({ role: "user", content: currentMessage });

    return messages;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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
