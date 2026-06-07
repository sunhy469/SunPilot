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
 * AgentService — 所有对话交互的统一入口。
 *
 * 职责边界：
 * - AgentService 是"门面"，负责：请求校验、会话管理、幂等性、Abort 控制、
 *   EventBus 订阅→推流钩子转发、审批裁决。
 * - AgentLoopEngine 是"引擎"，负责：上下文构建→意图路由→规划→工具决策→
 *   安全→执行→反思→响应→记忆 的完整状态机流转。
 *
 * 所有聊天命令通过 handleChatCommand → AgentLoopEngine.run 路由。
 * chat() 方法仅为旧 REST 调用方的兼容适配器，内部仍走 Agent Loop。
 */
export class AgentService {
  private readonly loopConfig: AgentLoopServiceConfig;

  constructor(config: AgentLoopServiceConfig) {
    this.loopConfig = config;
  }

  // ── Agent Loop 主路径 ────────────────────────────────────────────

  /**
   * 通过完整 Agent Loop 处理一次聊天命令。
   * 这是架构文档 §0.3 定义的唯一标准入口。
   *
   * 完整流程：
   * 1. 幂等性检查（基于 clientRequestId + 请求哈希）
   * 2. 创建 AbortSignal 用于取消控制
   * 3. 订阅 EventBus → 将 Agent 内部事件转发到 streamHooks
   * 4. 必要时创建 Conversation 记录
   * 5. 持久化 User Message
   * 6. 持久化 Run 初始状态（含 created 事件）
   * 7. 调用 AgentLoopEngine.run 启动状态机
   * 8. 清理 Abort/订阅 → 完成幂等性记录 → 触发 onCompleted
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
    // 幂等性保护：若客户端携带 clientRequestId 重放相同请求，
    // 则直接返回缓存结果，避免重复执行 Agent Loop。
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

    // 为本 run 创建 AbortSignal，用于用户取消或超时中断
    const signal = abortRegistry.create(runId);

    // 订阅 EventBus → 将 Agent 内部事件转发到 streamHooks，
    // 由 daemon 层的 JSON-RPC/WebSocket 推送给前端。
    // 特别处理 agent.response.delta 事件，将增量文本推送到 onDelta 钩子。
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
      // 必要时创建新会话（Conversation 持久化）
      if (shouldCreateConversation && this.loopConfig.conversations) {
        await this.loopConfig.conversations.createConversation({
          id: conversationId,
        });
      }

      // 持久化 Run 初始状态（优先使用 DB 初始化的原子写入）
      const initialized = this.loopConfig.agentRunInitializer
        ? await this.loopConfig.agentRunInitializer.createRunWithCreatedEvent(
            loopInput,
          )
        : undefined;
      if (!initialized) {
        await runStateManager.createRun(loopInput);
      }

      // 持久化用户消息
      if (this.loopConfig.conversations) {
        const userMessage = await this.loopConfig.conversations.createMessage({
          id: userMessageId,
          conversationId,
          role: "user",
          content: input.message,
        });
        await streamHooks?.onUserMessage?.(userMessage);
      }

      // 发出 run.created 事件（推送→前端通知"Run 已创建"）
      if (initialized) {
        // 使用 DB 原子写入时预构建的事件，保留 id 和 sequence
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

      // 启动 Agent Loop 状态机（核心执行路径）
      const result = await loopEngine.run(loopInput, signal);

      // 正常完成：清理 Abort 控制器和事件订阅
      abortRegistry.remove(runId);
      unsubscribe();

      const response = {
        ...result,
        conversationId,
        messageId: result.assistantMessageId ?? userMessageId,
      };
      // 标记幂等性记录为已完成，后续相同 clientRequestId 可直接重放
      await this.completeIdempotency(idempotency?.id, response);

      streamHooks?.onCompleted?.(result);

      return response;
    } catch (error) {
      // 异常路径：清理 Abort 控制器和事件订阅
      abortRegistry.remove(runId);
      unsubscribe();

      // 标记幂等性记录为失败（非幂等性错误仍可重试）
      await this.failIdempotency(idempotency?.id, error);

      // 将 Run 状态持久化为 failed，并发出错误事件
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
   * 通过 AbortRegistry 中止正在运行的聊天。
   * 仅触发 abort 信号，不持久化状态变更。
   */
  stopChat(runId: string): { stopped: boolean; runId: string } {
    const stopped = this.loopConfig.abortRegistry.abort(runId);
    return { stopped, runId };
  }

  /**
   * 取消一个 Agent Run。
   *
   * 与 stopChat 的区别：cancelRun 在 abort 流的同时将 Run 状态持久化为
   * cancelled，并发出 agent.run.cancelled 事件，前端可据此更新 UI。
   *
   * 这是面向 Web/CLI/API 客户端的标准取消入口。
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

  /**
   * 恢复一个被中断/暂停的 Run。
   * 内部复用 createRunAttempt("resume")，校验状态为 interruptable 后创建新 Run。
   */
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

  /**
   * 重试一个失败的 Run。
   * 内部复用 createRunAttempt("retry")，校验状态为 retryable 后创建新 Run。
   */
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
   * 批准一个待审批的请求。
   *
   * 两条路径：
   * 1. 有 approvalDecisionService（DB 持久化）→ 通过 DB 层审批
   * 2. 仅有 approvalGate（内存）→ 通过内存 Gate 审批
   *
   * 批准后调用 loopEngine.resumeApprovedTool 继续执行被暂停的工具调用。
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
   * 拒绝一个待审批的请求。
   * 拒绝后 Run 将保持 waiting_approval 状态，允许用户手动取消。
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

  /**
   * resume 和 retry 的共享实现。
   * 1. 从 DB/内存获取源 Run
   * 2. 校验状态是否允许 resume/retry（仅 interrupted/failed/cancelled）
   * 3. 从源 Run 提取消息和模式
   * 4. 通过 handleChatCommand 创建新 Run
   * 5. 记录 attempt 链：在原 Run context 中标记新 Run ID
   */
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

  /**
   * 幂等性保留：基于 clientRequestId + 请求哈希进行去重。
   *
   * 返回值分三种情况：
   * - inserted：首次请求，正常执行 Agent Loop
   * - replay：重复请求且结果已缓存，直接返回缓存结果
   * - 抛错：clientRequestId 冲突（不同请求用同一 ID）或正在进行中
   *
   * 幂等性窗口为 24 小时，超过窗口的记录视为过期。
   */
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
