import type { AgentLoopInput, AgentLoopResult, ToolDecision } from "../loop-types.js";
import { AssistantMessageStream } from "../assistant-message-stream.js";
import type { AgentLoopEngineDeps } from "../agent-loop-engine.js";

/** Completes clarification, failure/cancellation, and memory side effects. */
export class RunOutcomeCoordinator {
  constructor(
    private readonly deps: AgentLoopEngineDeps,
    private readonly cleanupRun: (runId: string) => void,
  ) {}

  // ── Branch handlers ────────────────────────────────────────────────


  /** 分支 B：无需工具 — 直接 LLM 生成回复。 */
  /** 分支 C：请求澄清 — 向用户发问（§P1: content-block stream）。 */
  async handleClarification(
    input: AgentLoopInput,
    decision: ToolDecision & { type: "ask_clarification" },
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;
    const messageId = `msg_${crypto.randomUUID()}`;

    await this.deps.runStateManager.markStatus(runId, "responding");

    // §P1: Content-block stream path for clarification.
    // Emits text part + optional status, then completes the message.
    if (this.deps.saveMessage) {
      const stream = new AssistantMessageStream({
        runId,
        conversationId,
        messageId,
        eventBus: this.deps.eventBus,
        saveMessage: this.deps.saveMessage,
        skipStartedEvents: true,
      });
      stream.start();

      // Emit clarification as a text part
      // §P0-1: Clarification is the final answer (no tool will run).
      const textPart = stream.startTextPart("final");
      stream.appendText(textPart.id, decision.question);
      stream.completeTextPart(textPart.id);

      // When the clarification was triggered by missing parameters,
      // add a recoverable error part so the UI can show context.
      if (decision.reason.includes("missing") || decision.reason.includes("缺少")) {
        stream.addError({
          message: decision.reason,
          code: "CLARIFICATION_NEEDED",
          recoverable: true,
        });
      }

      // Also emit legacy clarification event for backward compatibility
      this.deps.eventBus.emit(
        "agent.clarification.requested",
        {
          runId,
          conversationId,
          messageId,
          question: decision.question,
          reason: decision.reason,
        },
        { runId, conversationId },
      );

      await stream.complete();

      await this.deps.runStateManager.markStatus(runId, "completed");
      this.deps.eventBus.emit(
        "agent.run.completed",
        {
          runId,
          assistantMessageId: messageId,
          artifacts: [],
          toolCalls: 0,
        },
        { runId, conversationId },
      );

      this.cleanupRun(runId);

      return {
        runId,
        conversationId,
        assistantMessageId: messageId,
        status: "completed",
        artifacts: [],
        toolCalls: [],
      };
    }

    // Fallback: old path (no saveMessage available)
    const response = await this.deps.responseComposer.composeClarification({
      input,
      question: decision.question,
      reason: decision.reason,
    });

    await this.deps.runStateManager.markStatus(runId, "completed");
    this.deps.eventBus.emit(
      "agent.run.completed",
      {
        runId,
        assistantMessageId: response.messageId,
        artifacts: [],
        toolCalls: 0,
      },
      { runId, conversationId },
    );

    return {
      runId,
      conversationId,
      assistantMessageId: response.messageId,
      status: "completed",
      artifacts: [],
      toolCalls: [],
    };
  }

  /** 分支 D：决策阶段即需审批。 */
  async handleLoopError(
    input: AgentLoopInput,
    error: unknown,
    signal: AbortSignal,
  ): Promise<AgentLoopResult> {
    const { runId, conversationId } = input;

    if (signal.aborted) {
      await this.deps.runStateManager.markCancelled(runId, "aborted by user");
      this.deps.eventBus.emit(
        "agent.run.cancelled",
        { runId, reason: "aborted by user" },
        { runId, conversationId },
      );
      this.cleanupRun(runId);
      return {
        runId,
        conversationId,
        status: "cancelled",
        artifacts: [],
        toolCalls: [],
      };
    }

    const err = error instanceof Error ? error : new Error(String(error));
    const agentError = {
      code: (error as { code?: string }).code ?? "AGENT_INTERNAL_ERROR",
      message: err.message,
      category: (error as { category?: string }).category ?? "internal",
      retryable: (error as { retryable?: boolean }).retryable ?? false,
    };

    await this.deps.runStateManager.markFailed(runId, error);
    this.deps.eventBus.emit(
      "agent.run.failed",
      { runId, error: agentError },
      { runId, conversationId },
    );
    this.deps.eventBus.emit(
      "agent.error",
      {
        runId,
        conversationId,
        code: agentError.code,
        message: agentError.message,
        category: agentError.category,
        retryable: agentError.retryable,
      },
      { runId, conversationId },
    );

    this.cleanupRun(runId);
    return {
      runId,
      conversationId,
      status: "failed",
      artifacts: [],
      toolCalls: [],
      error: agentError,
    };
  }

  /**
   * 写入记忆（最佳努力，失败不阻塞主流程）。
   *
   * 写入策略由 MemoryWriter 内部决定：
   * - 用户显式"记住" → 高置信度写入
   * - 意图为 memory_update → 中置信度写入
   * - 工具任务完成 → 生成任务摘要记忆
   *
   * 每条写入的记忆都会 emit agent.memory.written 事件。
   */
  async writeMemories(
    input: Parameters<
      NonNullable<AgentLoopEngineDeps["memoryWriter"]>["writeFromTurn"]
    >[0],
  ): Promise<void> {
    if (!this.deps.memoryWriter) return;

    try {
      const result = await this.deps.memoryWriter.writeFromTurn(input);
      for (const memory of result.written) {
        this.deps.eventBus.emit(
          "agent.memory.written",
          {
            runId: input.input.runId,
            memoryId: memory.id,
            type: memory.type ?? "manual_note",
            scope: memory.scope ?? "run",
          },
          {
            runId: input.input.runId,
            conversationId: input.input.conversationId,
          },
        );
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.deps.eventBus.emit(
        "agent.error",
        {
          runId: input.input.runId,
          conversationId: input.input.conversationId,
          code: "AGENT_MEMORY_WRITE_FAILED",
          message: err.message,
          category: "memory",
          retryable: true,
        },
        {
          runId: input.input.runId,
          conversationId: input.input.conversationId,
        },
      );
    }
  }
}
