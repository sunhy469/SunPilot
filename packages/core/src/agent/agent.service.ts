import { createHash } from "node:crypto";
import { notFound } from "../errors/index.js";
import { AuditActor } from "@sunpilot/protocol";
import type { IdempotencyRepository } from "@sunpilot/storage";
import type { DatabaseContext } from "@sunpilot/storage";
import type {
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

export type AgentStreamDelta = {
  type: "agent.message.part.delta";
  runId?: string;
  conversationId: string;
  messageId: string;
  partId: string;
  delta: string;
};

export interface AgentLoopServiceConfig {
  loopEngine: AgentLoopEngine;
  abortRegistry: AbortRegistry;
  eventBus: AgentEventBus;
  /** Persisted-event bus for external consumers (WebSocket, stream hooks).
   *  Carries only events with a real DB sequence. */
  liveEventBus?: AgentEventBus;
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
      attachments?: Array<{
        id: string;
        name: string;
        type: string;
        sizeBytes?: number;
        url?: string;
        dataUrl?: string;
        storageKey?: string;
        provider?: "aliyun-oss" | "s3" | "minio" | "local";
        checksum?: string;
      }>;
    }): Promise<AgentMessage>;
    listMessages(conversationId: string): Promise<AgentMessage[]>;
  };
}

/** §5.4: Validate image attachment integrity before entering agent loop. */
function isImageAttachment(a: { type: string; name?: string }): boolean {
  return (
    a.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i.test(a.name ?? "")
  );
}

function assertUsableImageAttachments(input: {
  message: string;
  attachments?: Array<{
    id: string;
    name: string;
    type: string;
    url?: string;
    dataUrl?: string;
    storageKey?: string;
  }>;
}): void {
  const asksImageSearch =
    /1688|货源|同款|搜图|图片|相机|商品/i.test(input.message);

  if (!asksImageSearch) return;

  const imageAttachments = (input.attachments ?? []).filter(isImageAttachment);
  if (imageAttachments.length === 0) {
    throw Object.assign(
      new Error("搜索 1688 货源需要上传商品图片，请先上传图片后再试。"),
      { code: "IMAGE_ATTACHMENT_REQUIRED", category: "input_validation", retryable: false },
    );
  }

  const usable = imageAttachments.some(
    (a) => Boolean(a.url || a.dataUrl || a.storageKey),
  );
  if (!usable) {
    throw Object.assign(
      new Error("图片尚未上传完成，缺少可用的图片链接。请等待上传完成后再试。"),
      { code: "IMAGE_ATTACHMENT_REF_MISSING", category: "input_validation", retryable: false },
    );
  }
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
   * WebSocket fast-ack entry point.
   *
   * Creates the conversation, user message, and run record synchronously,
   * returns { accepted: true, runId, conversationId, messageId } immediately,
   * then executes the Agent Loop in the background via queueMicrotask.
   *
   * All progress is streamed through agent.* events on the event bus —
   * the caller should subscribe to liveEventBus for updates.
   *
   * This is the recommended entry point for WebSocket chat.send.
   * Use handleChatCommand() for synchronous REST or test callers.
   */
  async startChatCommand(
    input: {
      conversationId?: string;
      message: string;
      mode?: "chat" | "agent";
      permissionMode?: "ask" | "auto" | "full";
      modelId?: "dp" | "seed";
      clientRequestId?: string;
      attachments?: Array<{
        id: string;
        name: string;
        type: string;
        sizeBytes?: number;
        url?: string;
        dataUrl?: string;
        storageKey?: string;
        provider?: "aliyun-oss" | "s3" | "minio" | "local";
        checksum?: string;
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
      onDelta?: (delta: AgentStreamDelta) => void;
      onCompleted?: (result: AgentLoopResult) => void;
      onError?: (error: unknown) => void;
    },
  ): Promise<{
    accepted: true;
    runId: string;
    conversationId: string;
    messageId: string;
  }> {
    const { loopEngine, abortRegistry, runStateManager, eventBus, liveEventBus } =
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
      permissionMode: input.permissionMode,
      modelId: input.modelId,
      attachments: input.attachments,
      client: {
        source: ctx.source,
        connectionId: ctx.connectionId,
      },
    };

    // Idempotency check
    const idempotency = input.clientRequestId
      ? await this.reserveIdempotency(
          input.clientRequestId,
          input,
          loopInput,
          ctx,
        )
      : undefined;
    if (idempotency?.replay) {
      // Return the replay data immediately
      return {
        accepted: true,
        runId: idempotency.replay.runId,
        conversationId: idempotency.replay.conversationId,
        messageId: idempotency.replay.messageId,
      };
    }

    // §5.4: Validate image attachment integrity before creating run
    assertUsableImageAttachments({ message: input.message, attachments: input.attachments });

    // Create abort signal for this run
    const signal = abortRegistry.create(runId);

    // Subscribe to events for streaming hooks
    const unsubLive = liveEventBus?.subscribe((event) => {
      if (event.runId !== runId) return;
      streamHooks?.onEvent?.(event);
    }) ?? (() => {});

    const unsub = eventBus.subscribe((event) => {
      if (event.runId !== runId) return;
      if (
        streamHooks?.onDelta &&
        event.type === "agent.message.part.delta"
      ) {
        const payload = event.payload as {
          conversationId?: string;
          messageId: string;
          partId: string;
          delta: string;
        };
        streamHooks.onDelta({
          type: "agent.message.part.delta",
          runId: event.runId,
          conversationId: payload.conversationId ?? event.conversationId ?? "",
          messageId: payload.messageId,
          partId: payload.partId,
          delta: payload.delta,
        });
      }
    });

    // Create conversation if needed
    if (shouldCreateConversation && this.loopConfig.conversations) {
      await this.loopConfig.conversations.createConversation({
        id: conversationId,
        title: input.message.slice(0, 100),
      });
    }

    // Persist run initial state
    const initialized = this.loopConfig.agentRunInitializer
      ? await this.loopConfig.agentRunInitializer.createRunWithCreatedEvent(
          loopInput,
        )
      : undefined;
    if (!initialized) {
      await runStateManager.createRun(loopInput);
    }

    // Persist user message with attachments
    if (this.loopConfig.conversations) {
      const userMessage = await this.loopConfig.conversations.createMessage({
        id: userMessageId,
        conversationId,
        role: "user",
        content: input.message,
        attachments: input.attachments?.map((a) => ({
          id: a.id,
          name: a.name,
          type: a.type,
          sizeBytes: a.sizeBytes,
          url: a.url,
          dataUrl: a.dataUrl,
          storageKey: a.storageKey,
          provider: a.provider,
          checksum: a.checksum,
        })),
      });
      await streamHooks?.onUserMessage?.(userMessage);
    }

    // Publish run.created event
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

    // ── Execute Agent Loop in background ───────────────────────────
    queueMicrotask(() => {
      void (async () => {
        try {
          const result = await loopEngine.run(loopInput, signal);
          abortRegistry.remove(runId);
          await eventBus.flush();
          unsubLive();
          unsub();

          const response = {
            ...result,
            conversationId,
            messageId: result.assistantMessageId ?? userMessageId,
          };
          await this.completeIdempotency(idempotency?.id, response);
          streamHooks?.onCompleted?.(result);
        } catch (error) {
          abortRegistry.remove(runId);
          await eventBus.flush();
          unsubLive();
          unsub();

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
        }
      })();
    });

    return {
      accepted: true,
      runId,
      conversationId,
      messageId: userMessageId,
    };
  }

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
      mode?: "chat" | "agent";
      permissionMode?: "ask" | "auto" | "full";
      modelId?: "dp" | "seed";
      clientRequestId?: string;
      attachments?: Array<{
        id: string;
        name: string;
        type: string;
        sizeBytes?: number;
        url?: string;
        dataUrl?: string;
        storageKey?: string;
        provider?: "aliyun-oss" | "s3" | "minio" | "local";
        checksum?: string;
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
      onDelta?: (delta: AgentStreamDelta) => void;
      onCompleted?: (result: AgentLoopResult) => void;
      onError?: (error: unknown) => void;
    },
  ): Promise<AgentLoopResult & { conversationId: string; messageId: string }> {
    const { loopEngine, abortRegistry, runStateManager, eventBus, liveEventBus } =
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
      permissionMode: input.permissionMode,
      modelId: input.modelId,
      attachments: input.attachments,
      client: {
        source: ctx.source,
        connectionId: ctx.connectionId,
      },
    };

    // §5.4: Validate image attachment integrity before entering agent loop
    assertUsableImageAttachments({ message: input.message, attachments: input.attachments });

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

    // ── Event subscriptions ────────────────────────────────────
    // liveEventBus carries only persisted events with real DB sequences.
    // Normal agent.* events MUST have a real sequence — use liveEventBus
    // for onEvent so the sender connection never sees sequence: -1 on
    // replayable events.
    const unsubLive = liveEventBus?.subscribe((event) => {
      if (event.runId !== runId) return;
      streamHooks?.onEvent?.(event);
    }) ?? (() => {});

    // Raw eventBus subscription — only for real-time delta streaming.
    // Deltas are transient and must not wait for DB persist; they arrive
    // here before the persist subscriber writes them to the database.
    // §Token ordering fix: also sync-forward agent.message.part.delta
    // (bypasses the async persistence bridge which can reorder chunks).
    const unsub = eventBus.subscribe((event) => {
      if (event.runId !== runId || !streamHooks?.onDelta) return;
      if (event.type === "agent.message.part.delta") {
        const payload = event.payload as {
          conversationId?: string;
          messageId: string;
          partId: string;
          delta: string;
        };
        streamHooks.onDelta({
          type: "agent.message.part.delta",
          runId: event.runId,
          conversationId: payload.conversationId ?? event.conversationId ?? "",
          messageId: payload.messageId,
          partId: payload.partId,
          delta: payload.delta,
        });
      }
    });

    try {
      // 必要时创建新会话（Conversation 持久化）
      if (shouldCreateConversation && this.loopConfig.conversations) {
        await this.loopConfig.conversations.createConversation({
          id: conversationId,
          title: input.message.slice(0, 100),
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

      // 持久化用户消息（含附件引用）
      if (this.loopConfig.conversations) {
        const userMessage = await this.loopConfig.conversations.createMessage({
          id: userMessageId,
          conversationId,
          role: "user",
          content: input.message,
          attachments: input.attachments?.map((a) => ({
            id: a.id,
            name: a.name,
            type: a.type,
            sizeBytes: a.sizeBytes,
            url: a.url,
            dataUrl: a.dataUrl,
            storageKey: a.storageKey,
            provider: a.provider,
            checksum: a.checksum,
          })),
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
      // Wait for pending async listeners (notably the raw→persist→live bridge)
      // to publish persisted events to liveEventBus before unsubscribing.
      // Without this flush, a fast return could unsubLive() before the persist
      // bridge completes, causing the current connection to miss events.
      await eventBus.flush();
      unsubLive();
      unsub();

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
      // Flush pending persists before unsubscribing so the current connection
      // receives any events that were emitted before the error.
      await eventBus.flush();
      unsubLive();
      unsub();

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
          messageId: approval.messageId ?? approval.requestedAction.messageId,
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
   *
   * 拒绝策略 (rejectionStrategy):
   *   - "cancel": 取消 run（默认，原行为是保持 waiting_approval）
   *   - "interrupt": 中断 run，允许用户后续重试
   *   - "continue_without_tool": 跳过被拒绝的工具，继续 agent loop
   *
   * 拒绝后根据策略转换 run 状态，不再无限期保持在 waiting_approval。
   */
  async reject(
    approvalId: string,
    decidedBy?: string,
    reason?: string,
    rejectionStrategy: "cancel" | "interrupt" | "continue_without_tool" = "interrupt",
  ): Promise<{ rejected: boolean; runId: string; strategy: string }> {
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

    const run = await this.loopConfig.runStateManager.getRun(approval.runId);
    const conversationId = run?.conversationId;

    // Transition run state based on rejection strategy
    switch (rejectionStrategy) {
      case "cancel":
        await this.loopConfig.runStateManager.markCancelled(
          approval.runId,
          reason ?? "approval rejected — cancelled by user",
        );
        this.loopConfig.abortRegistry.abort(approval.runId);
        break;
      case "continue_without_tool":
        // Continue the agent loop without the rejected tool.
        // Fire-and-forget in background: rebuilds context, reflects,
        // and responds to the user explaining the tool was skipped.
        await this.loopConfig.runStateManager.markStatus(
          approval.runId,
          "responding",
          reason ?? "approval rejected — continuing without tool",
        );
        queueMicrotask(() => {
          const signal = this.loopConfig.abortRegistry.create(approval.runId);
          this.loopConfig.loopEngine
            .continueAfterRejection(
              {
                runId: approval.runId,
                conversationId: conversationId ?? "",
                userId: decidedBy,
                originalMessage: run?.goal ?? reason ?? "Continue without tool",
                mode:
                  run?.mode === "chat" || run?.mode === "agent"
                    ? run.mode
                    : "agent",
              },
              signal,
            )
            .catch(() => {
              // Best effort — errors handled internally by loop engine
            })
            .finally(() => {
              this.loopConfig.abortRegistry.remove(approval.runId);
            });
        });
        break;
      case "interrupt":
      default:
        await this.loopConfig.runStateManager.markStatus(
          approval.runId,
          "interrupted",
          reason ?? "approval rejected by user",
        );
        break;
    }

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
          strategy: rejectionStrategy,
        },
        { runId: approval.runId, conversationId },
      );
    }

    return {
      rejected: true,
      runId: approval.runId,
      strategy: rejectionStrategy,
    };
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

    // §5.3: Preserve original attachments on retry/resume so image search
    // tools have access to previously uploaded image references. The source
    // run stores { message, attachments, client } in its input field.
    // RunRecord has `.input`, RunState does not — only extract when available.
    const sourceInput = (sourceRun as { input?: unknown }).input;
    const sourceAttachments = extractAttachments(sourceInput);

    const result = await this.handleChatCommand(
      {
        conversationId,
        message,
        mode,
        attachments: sourceAttachments,
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
      actor: AuditActor.Agent,
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
      mode?: "chat" | "agent";
      attachments?: Array<{
        id: string;
        name: string;
        type: string;
        sizeBytes?: number;
        url?: string;
        dataUrl?: string;
        storageKey?: string;
        provider?: "aliyun-oss" | "s3" | "minio" | "local";
        checksum?: string;
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

function normalizeAttemptMode(mode: unknown): "chat" | "agent" {
  return mode === "chat" ? mode : "agent";
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

/**
 * §5.3: Extract attachments from a run's stored input for retry/resume.
 * The source run stores `{ message, attachments, client }` in its input field.
 * Returns undefined when no attachments are stored (e.g. original request had none).
 */
function extractAttachments(
  input: unknown,
): Array<{
  id: string;
  name: string;
  type: string;
  sizeBytes?: number;
  url?: string;
  dataUrl?: string;
  storageKey?: string;
  provider?: "aliyun-oss" | "s3" | "minio" | "local";
  checksum?: string;
}> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as { attachments?: unknown };
  if (!Array.isArray(record.attachments) || record.attachments.length === 0) {
    return undefined;
  }
  return record.attachments as Array<{
    id: string;
    name: string;
    type: string;
    sizeBytes?: number;
    url?: string;
    dataUrl?: string;
    storageKey?: string;
    provider?: "aliyun-oss" | "s3" | "minio" | "local";
    checksum?: string;
  }>;
}
