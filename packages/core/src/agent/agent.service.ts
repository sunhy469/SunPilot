import { createHash } from "node:crypto";
import { notFound } from "../errors/index.js";
import type { IdempotencyRepository } from "@sunpilot/storage";
import type { DatabaseContext } from "@sunpilot/storage";
import { parseAgentChatRequest } from "./agent.schema.js";
import type {
  AgentChatHooks,
  AgentChatResponse,
  AgentConversation,
  AgentMessage,
} from "./agent.types.js";
import type { AbortRegistry } from "../agent-kernel/abort-registry.js";
import type { AgentEventBus } from "../agent-kernel/agent-event-bus.js";
import type { AgentLoopEngine } from "../agent-kernel/agent-loop-engine.js";
import type {
  AgentLoopInput,
  AgentLoopResult,
} from "../agent-kernel/loop-types.js";
import type { AgentEvent } from "../agent-kernel/agent-event-bus.js";
import type { RunStateManager } from "../agent-kernel/run-state-manager.js";
import type { ApprovalGate } from "../agent-kernel/loop-types.js";
import type {
  ApprovalDecisionResult,
  RepositoryApprovalDecisionService,
} from "../agent-kernel/persistence/repository-approval-decision-service.js";
import type { RepositoryAgentRunInitializer } from "../agent-kernel/persistence/repository-agent-run-initializer.js";

export interface AgentLoopServiceConfig {
  loopEngine: AgentLoopEngine;
  abortRegistry: AbortRegistry;
  eventBus: AgentEventBus;
  runStateManager: RunStateManager;
  approvalGate: ApprovalGate;
  approvalDecisionService?: RepositoryApprovalDecisionService;
  agentRunInitializer?: RepositoryAgentRunInitializer;
  idempotency?: IdempotencyRepository;
  database?: DatabaseContext;
  conversations?: {
    createConversation(input?: {
      id?: string;
      title?: string;
    }): Promise<AgentConversation>;
    findConversationById(id: string): Promise<AgentConversation | null>;
    createMessage(input: {
      id?: string;
      conversationId: string;
      role: string;
      content: string;
    }): Promise<AgentMessage>;
    listMessages(conversationId: string): Promise<AgentMessage[]>;
  };
}

/**
 * AgentService — the primary entry point for all chat interactions.
 *
 * All chat-like commands are routed through handleChatCommand →
 * AgentLoopEngine.run. The chat() method remains only as a compatibility
 * adapter for older REST callers; it no longer performs direct LLM calls.
 */
export class AgentService {
  private readonly loopConfig: AgentLoopServiceConfig;

  constructor(config: AgentLoopServiceConfig) {
    this.loopConfig = config;
  }

  // ── NEW: Agent Loop path ─────────────────────────────────────────

  /**
   * Handle a chat command through the full Agent Loop.
   * This is the primary entry point per architecture doc §0.3.
   */
  async handleChatCommand(
    input: {
      conversationId?: string;
      message: string;
      mode?: "chat" | "agent" | "workflow";
      clientRequestId?: string;
      attachments?: Array<{
        id: string;
        name: string;
        type: string;
        sizeBytes?: number;
      }>;
    },
    ctx: {
      source: "web" | "cli" | "api";
      connectionId?: string;
      userId?: string;
    },
    streamHooks?: {
      onUserMessage?: (
        message: AgentChatResponse["message"],
      ) => void | Promise<void>;
      onEvent?: (event: AgentEvent) => void;
      onDelta?: (delta: {
        conversationId: string;
        messageId: string;
        delta: string;
      }) => void;
      onCompleted?: (result: AgentLoopResult) => void;
      onError?: (error: unknown) => void;
    },
  ): Promise<AgentLoopResult & { conversationId: string; messageId: string }> {
    const { loopEngine, abortRegistry, runStateManager, eventBus } =
      this.loopConfig;

    await this.assertConversationExists(input.conversationId);

    const shouldCreateConversation = !input.conversationId;
    const conversationId =
      input.conversationId ?? `conv_${crypto.randomUUID()}`;

    const runId = `run_${crypto.randomUUID()}`;
    const userMessageId = `msg_${crypto.randomUUID()}`;

    const loopInput: AgentLoopInput = {
      runId,
      conversationId,
      userMessageId,
      userId: ctx.userId,
      message: input.message,
      mode: input.mode ?? "agent",
      attachments: input.attachments,
      client: {
        source: ctx.source,
        connectionId: ctx.connectionId,
      },
    };
    const idempotency = input.clientRequestId
      ? await this.reserveIdempotency(
          input.clientRequestId,
          input,
          loopInput,
          ctx,
        )
      : undefined;
    if (idempotency?.replay) {
      return idempotency.replay;
    }

    // Create the abort signal for this run
    const signal = abortRegistry.create(runId);

    // Subscribe to Agent events and forward to stream hooks
    const unsubscribe = eventBus.subscribe((event) => {
      if (event.runId === runId) {
        streamHooks?.onEvent?.(event);
      }
      if (
        streamHooks?.onDelta &&
        event.type === "agent.response.delta" &&
        event.runId === runId
      ) {
        const payload = event.payload as {
          conversationId: string;
          messageId: string;
          delta: string;
        };
        streamHooks.onDelta({
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          delta: payload.delta,
        });
      }
    });

    try {
      if (shouldCreateConversation && this.loopConfig.conversations) {
        await this.loopConfig.conversations.createConversation({
          id: conversationId,
        });
      }

      const initialized = this.loopConfig.agentRunInitializer
        ? await this.loopConfig.agentRunInitializer.createRunWithCreatedEvent(
            loopInput,
          )
        : undefined;
      if (!initialized) {
        await runStateManager.createRun(loopInput);
      }

      if (this.loopConfig.conversations) {
        const userMessage = await this.loopConfig.conversations.createMessage({
          id: userMessageId,
          conversationId,
          role: "user",
          content: input.message,
        });
        await streamHooks?.onUserMessage?.(userMessage);
      }

      if (initialized) {
        eventBus.publish(initialized.event);
      } else {
        eventBus.emit(
          "agent.run.created",
          {
            runId,
            conversationId,
            mode: loopInput.mode,
            goal: input.message,
          },
          { runId, conversationId },
        );
      }

      // Run the Agent Loop
      const result = await loopEngine.run(loopInput, signal);

      // Clean up
      abortRegistry.remove(runId);
      unsubscribe();

      const response = {
        ...result,
        conversationId,
        messageId: result.assistantMessageId ?? userMessageId,
      };
      await this.completeIdempotency(idempotency?.id, response);

      streamHooks?.onCompleted?.(result);

      return response;
    } catch (error) {
      abortRegistry.remove(runId);
      unsubscribe();

      await this.failIdempotency(idempotency?.id, error);

      await runStateManager.markFailed(runId, error);
      eventBus.emit(
        "agent.error",
        {
          runId,
          conversationId,
          code: "AGENT_INTERNAL_ERROR",
          message: error instanceof Error ? error.message : String(error),
          category: "internal",
          retryable: false,
        },
        { runId, conversationId },
      );

      streamHooks?.onError?.(error);
      throw error;
    }
  }

  /**
   * Stop a running chat via AbortRegistry.
   * Replaces the placeholder `{ stopped: true }` implementation.
   */
  stopChat(runId: string): { stopped: boolean; runId: string } {
    const stopped = this.loopConfig.abortRegistry.abort(runId);
    return { stopped, runId };
  }

  /**
   * Cancel an Agent run through the Agent state manager.
   *
   * This is the command-oriented counterpart to chat.stop: it aborts any active
   * stream and persists the run as cancelled, producing the canonical
   * `agent.run.cancelled` event for Web/CLI/API clients.
   */
  async cancelRun(
    runId: string,
    reason = "cancelled by user",
  ): Promise<{ cancelled: true; runId: string; stopped: boolean }> {
    const stopped = this.loopConfig.abortRegistry.abort(runId);
    await this.loopConfig.runStateManager.markCancelled(runId, reason);
    const run = await this.loopConfig.runStateManager.getRun(runId);
    this.loopConfig.eventBus.emit(
      "agent.run.cancelled",
      { runId, reason },
      { runId, conversationId: run?.conversationId },
    );
    this.loopConfig.abortRegistry.remove(runId);
    return { cancelled: true, runId, stopped };
  }

  async resumeRun(runId: string): Promise<{
    resumed: true;
    originalRunId: string;
    runId: string;
    conversationId: string;
    messageId: string;
    status: AgentLoopResult["status"];
  }> {
    return this.createRunAttempt(runId, "resume");
  }

  async retryRun(runId: string): Promise<{
    retried: true;
    originalRunId: string;
    runId: string;
    conversationId: string;
    messageId: string;
    status: AgentLoopResult["status"];
  }> {
    const attempt = await this.createRunAttempt(runId, "retry");
    return {
      retried: true,
      originalRunId: attempt.originalRunId,
      runId: attempt.runId,
      conversationId: attempt.conversationId,
      messageId: attempt.messageId,
      status: attempt.status,
    };
  }

  /**
   * Approve a pending approval request.
   */
  async approve(
    approvalId: string,
    decidedBy?: string,
  ): Promise<{ approved: boolean }> {
    const approval = this.loopConfig.approvalDecisionService
      ? await this.loopConfig.approvalDecisionService.approve(
          approvalId,
          decidedBy,
        )
      : await this.loopConfig.approvalGate.approve(approvalId, decidedBy);
    const run = await this.loopConfig.runStateManager.getRun(approval.runId);
    if (hasPersistedApprovalEvent(approval)) {
      this.loopConfig.eventBus.publish(approval.event);
    } else {
      this.loopConfig.eventBus.emit(
        "agent.approval.approved",
        {
          runId: approval.runId,
          approvalId: approval.approvalId,
          decidedBy: approval.decidedBy,
        },
        { runId: approval.runId, conversationId: run?.conversationId },
      );
    }
    if (!approval.requestedAction) {
      throw Object.assign(
        new Error(`Approval ${approvalId} does not include a resumable action`),
        { code: "AGENT_APPROVAL_NOT_RESUMABLE" },
      );
    }

    const signal = this.loopConfig.abortRegistry.create(approval.runId);
    try {
      await this.loopConfig.loopEngine.resumeApprovedTool(
        {
          approvalId: approval.approvalId,
          runId: approval.runId,
          conversationId: run?.conversationId,
          decidedBy: approval.decidedBy,
          title: approval.title,
          riskLevel: approval.riskLevel,
          requestedAction: approval.requestedAction,
        },
        signal,
      );
    } finally {
      this.loopConfig.abortRegistry.remove(approval.runId);
    }
    return { approved: true };
  }

  /**
   * Reject a pending approval request.
   */
  async reject(
    approvalId: string,
    decidedBy?: string,
    reason?: string,
  ): Promise<{ rejected: boolean }> {
    const approval = this.loopConfig.approvalDecisionService
      ? await this.loopConfig.approvalDecisionService.reject(
          approvalId,
          decidedBy,
          reason,
        )
      : await this.loopConfig.approvalGate.reject(
          approvalId,
          decidedBy,
          reason,
        );
    if (hasPersistedApprovalEvent(approval)) {
      this.loopConfig.eventBus.publish(approval.event);
    } else {
      this.loopConfig.eventBus.emit(
        "agent.approval.rejected",
        {
          runId: approval.runId,
          approvalId: approval.approvalId,
          decidedBy: approval.decidedBy,
          reason: approval.reason,
        },
        { runId: approval.runId },
      );
    }
    return { rejected: true };
  }

  private async createRunAttempt(
    runId: string,
    action: "resume" | "retry",
  ): Promise<{
    resumed: true;
    originalRunId: string;
    runId: string;
    conversationId: string;
    messageId: string;
    status: AgentLoopResult["status"];
  }> {
    const sourceRun =
      (await this.loopConfig.database?.runs.findById(runId)) ??
      (await this.loopConfig.runStateManager.getRun(runId));
    if (!sourceRun) {
      throw Object.assign(new Error(`Unknown run: ${runId}`), {
        code: "AGENT_RUN_NOT_FOUND",
        category: "run_state",
        retryable: false,
      });
    }

    const status = sourceRun.status;
    if (!isAttemptableStatus(status)) {
      throw Object.assign(
        new Error(`Cannot ${action} run ${runId} from status ${status}`),
        {
          code: "AGENT_RUN_STATE_CONFLICT",
          category: "run_state",
          retryable: false,
          details: { runId, status, action },
        },
      );
    }

    const message = messageFromRun(sourceRun);
    const conversationId =
      "conversationId" in sourceRun ? sourceRun.conversationId : undefined;
    if (!conversationId) {
      throw Object.assign(
        new Error(`Cannot ${action} run ${runId}; missing conversationId`),
        {
          code: "AGENT_RUN_NOT_RESUMABLE",
          category: "run_state",
          retryable: false,
          details: { runId, action },
        },
      );
    }

    const mode = normalizeAttemptMode(sourceRun.mode);
    const result = await this.handleChatCommand(
      {
        conversationId,
        message,
        mode,
      },
      { source: "api" },
    );

    await this.recordAttemptLink({
      action,
      originalRunId: runId,
      newRunId: result.runId,
      conversationId,
      status,
    });

    return {
      resumed: true,
      originalRunId: runId,
      runId: result.runId,
      conversationId: result.conversationId,
      messageId: result.messageId,
      status: result.status,
    };
  }

  private async recordAttemptLink(input: {
    action: "resume" | "retry";
    originalRunId: string;
    newRunId: string;
    conversationId: string;
    status: string;
  }): Promise<void> {
    const db = this.loopConfig.database;
    if (!db) return;
    const now = new Date().toISOString();
    const run = await db.runs.findById(input.newRunId);
    if (run) {
      await db.runs.updateContext(input.newRunId, {
        ...run.context,
        [`${input.action}Of`]: input.originalRunId,
        attempt: {
          action: input.action,
          originalRunId: input.originalRunId,
          originalStatus: input.status,
          createdAt: now,
        },
      });
    }
    await db.audit.create({
      runId: input.newRunId,
      actor: "agent",
      action: `run.${input.action}`,
      target: input.originalRunId,
      payload: {
        originalRunId: input.originalRunId,
        newRunId: input.newRunId,
        originalStatus: input.status,
      },
      createdAt: now,
    });
    await db.events.append({
      id: `evt_${crypto.randomUUID()}`,
      runId: input.newRunId,
      conversationId: input.conversationId,
      type: "agent.run.started",
      payload: {
        runId: input.newRunId,
        originalRunId: input.originalRunId,
        attemptAction: input.action,
      },
      createdAt: now,
    });
  }

  // ── Compatibility adapter ────────────────────────────────────────

  /**
   * @deprecated Use handleChatCommand() instead.
   * Kept for older REST callers, but always routes through the Agent Loop.
   */
  async chat(
    input: unknown,
    hooks: AgentChatHooks = {},
  ): Promise<AgentChatResponse> {
    const request = parseAgentChatRequest(input);
    let assistantContent = "";
    const result = await this.handleChatCommand(
      {
        conversationId: request.conversationId,
        message: request.message,
        mode: "agent",
      },
      { source: "api" },
      {
        onUserMessage: (message) => hooks.onUserMessage?.(message),
        onEvent: (event) => {
          if (event.type !== "agent.response.started") return;
          const payload = event.payload as { messageId?: string };
          if (!payload.messageId) return;
          const started = {
            conversationId: event.conversationId ?? resultConversationId(event),
            messageId: payload.messageId,
          };
          return hooks.onAssistantStarted?.(started);
        },
        onDelta: (delta) => {
          assistantContent += delta.delta;
          return hooks.onAssistantDelta?.(delta);
        },
      },
    );

    const assistant = await this.findAssistantMessage(
      result.conversationId,
      result.messageId,
      assistantContent,
    );
    await hooks.onAssistantMessage?.(assistant);

    return {
      conversationId: result.conversationId,
      message: assistant,
    };
  }

  private async findAssistantMessage(
    conversationId: string,
    messageId: string,
    fallbackContent: string,
  ): Promise<AgentChatResponse["message"]> {
    if (this.loopConfig.conversations) {
      const messages =
        await this.loopConfig.conversations.listMessages(conversationId);
      const message = messages.find((item) => item.id === messageId);
      if (message) return message;
    }
    return {
      id: messageId,
      conversationId,
      role: "assistant",
      content: fallbackContent,
      createdAt: new Date().toISOString(),
    };
  }

  async assertConversationExists(
    conversationId: string | undefined,
  ): Promise<AgentConversation | undefined> {
    if (!conversationId || !this.loopConfig.conversations) return undefined;
    const conversation =
      await this.loopConfig.conversations.findConversationById(conversationId);
    if (!conversation) {
      throw notFound(`Unknown conversation: ${conversationId}`);
    }
    return conversation;
  }

  /** Check if the service is running in Agent Loop mode. */
  get isAgentLoopMode(): boolean {
    return true;
  }

  private async reserveIdempotency(
    clientRequestId: string,
    originalInput: {
      conversationId?: string;
      message: string;
      mode?: "chat" | "agent" | "workflow";
      attachments?: Array<{
        id: string;
        name: string;
        type: string;
        sizeBytes?: number;
      }>;
    },
    input: AgentLoopInput,
    ctx: { userId?: string },
  ): Promise<
    | { id: string; replay?: undefined }
    | {
        id?: undefined;
        replay: AgentLoopResult & { conversationId: string; messageId: string };
      }
  > {
    if (!this.loopConfig.idempotency) return { id: "" };
    const requestHash = hashIdempotencyRequest({
      conversationId: originalInput.conversationId,
      message: originalInput.message,
      mode: originalInput.mode ?? "agent",
      attachments: originalInput.attachments ?? [],
    });
    const initialResponse = {
      runId: input.runId,
      conversationId: input.conversationId,
      messageId: input.userMessageId,
      status: "created" as const,
      artifacts: [],
      toolCalls: [],
    };
    const reserved = await this.loopConfig.idempotency.reserve({
      userId: ctx.userId,
      method: "chat.send",
      clientRequestId,
      requestHash,
      initialResponse,
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    });
    if (reserved.inserted) return { id: reserved.record.id };

    if (reserved.record.requestHash !== requestHash) {
      throw Object.assign(
        new Error(
          `clientRequestId ${clientRequestId} was already used with a different request.`,
        ),
        {
          code: "AGENT_IDEMPOTENCY_CONFLICT",
          category: "idempotency",
          retryable: false,
        },
      );
    }
    if (reserved.record.status === "processing") {
      throw Object.assign(
        new Error(
          `clientRequestId ${clientRequestId} is already being processed.`,
        ),
        {
          code: "AGENT_IDEMPOTENCY_IN_PROGRESS",
          category: "idempotency",
          retryable: true,
        },
      );
    }
    if (reserved.record.status === "failed" && reserved.record.error) {
      const error = normalizeIdempotencyError(reserved.record.error);
      throw Object.assign(new Error(error.message), error);
    }
    if (reserved.record.status !== "completed") {
      throw Object.assign(
        new Error(
          `clientRequestId ${clientRequestId} is in an unknown idempotency state.`,
        ),
        {
          code: "AGENT_IDEMPOTENCY_CONFLICT",
          category: "idempotency",
          retryable: true,
        },
      );
    }
    return {
      replay: normalizeIdempotencyResponse(reserved.record.response),
    };
  }

  private async completeIdempotency(
    id: string | undefined,
    response: AgentLoopResult & { conversationId: string; messageId: string },
  ): Promise<void> {
    if (!id || !this.loopConfig.idempotency) return;
    await this.loopConfig.idempotency.complete(id, response);
  }

  private async failIdempotency(
    id: string | undefined,
    error: unknown,
  ): Promise<void> {
    if (!id || !this.loopConfig.idempotency) return;
    const normalized = {
      code: (error as { code?: string }).code ?? "AGENT_INTERNAL_ERROR",
      category: (error as { category?: string }).category ?? "internal",
      retryable: (error as { retryable?: boolean }).retryable ?? false,
      message: error instanceof Error ? error.message : String(error),
    };
    await this.loopConfig.idempotency.fail(id, normalized);
  }
}

function hashIdempotencyRequest(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeIdempotencyResponse(
  response: unknown,
): AgentLoopResult & { conversationId: string; messageId: string } {
  if (!response || typeof response !== "object") {
    throw Object.assign(new Error("Idempotency response is unavailable."), {
      code: "AGENT_IDEMPOTENCY_CONFLICT",
      category: "idempotency",
      retryable: true,
    });
  }
  return response as AgentLoopResult & {
    conversationId: string;
    messageId: string;
  };
}

function normalizeIdempotencyError(error: unknown): {
  code: string;
  category: string;
  retryable: boolean;
  message: string;
} {
  if (error && typeof error === "object") {
    const record = error as {
      code?: unknown;
      category?: unknown;
      retryable?: unknown;
      message?: unknown;
    };
    return {
      code:
        typeof record.code === "string" ? record.code : "AGENT_INTERNAL_ERROR",
      category:
        typeof record.category === "string" ? record.category : "internal",
      retryable:
        typeof record.retryable === "boolean" ? record.retryable : false,
      message:
        typeof record.message === "string"
          ? record.message
          : "Agent request failed.",
    };
  }
  return {
    code: "AGENT_INTERNAL_ERROR",
    category: "internal",
    retryable: false,
    message: String(error),
  };
}

function resultConversationId(event: AgentEvent): string {
  const payload = event.payload as { conversationId?: string };
  return event.conversationId ?? payload.conversationId ?? "";
}

function hasPersistedApprovalEvent(
  approval: unknown,
): approval is ApprovalDecisionResult {
  return (
    typeof approval === "object" && approval !== null && "event" in approval
  );
}

function isAttemptableStatus(status: unknown): boolean {
  return (
    status === "interrupted" || status === "failed" || status === "cancelled"
  );
}

function normalizeAttemptMode(mode: unknown): "chat" | "agent" | "workflow" {
  return mode === "chat" || mode === "workflow" ? mode : "agent";
}

function messageFromRun(run: { goal?: string; input?: unknown }): string {
  if (typeof run.goal === "string" && run.goal.trim()) return run.goal;
  const input = run.input;
  if (input && typeof input === "object") {
    const record = input as { message?: unknown };
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
  }
  throw Object.assign(new Error("Run does not contain a resumable message."), {
    code: "AGENT_RUN_NOT_RESUMABLE",
    category: "run_state",
    retryable: false,
  });
}
