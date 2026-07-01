import type { AgentService } from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import {
  approvalDecideSchema,
  approvalRejectSchema,
  chatSendSchema,
  chatStopSchema,
  conversationSubscribeSchema,
  conversationUnsubscribeSchema,
  JSON_RPC_ERROR_CODES,
  runCancelSchema,
  runRetrySchema,
  runResumeSchema,
  runSubscribeSchema,
  runUnsubscribeSchema,
} from "@sunpilot/protocol";
import {
  agentErrorNotification,
  agentEventParams,
  websocketNotificationForEvent,
} from "./ws-protocol.js";

export interface JsonRpcCommand {
  id?: string;
  method?: string;
  params?: unknown;
}

export interface JsonRpcConnectionContext {
  source: "web" | "cli" | "api";
  connectionId: string;
  runSubscriptions: Set<string>;
  conversationSubscriptions: Set<string>;
  notify(notification: unknown): void;
}

export type JsonRpcRouterResponse =
  | { result: unknown; error?: undefined }
  | {
      result?: undefined;
      error: { code: number; message: string; data?: unknown };
    };

export interface JsonRpcRouterDeps {
  getChatAgent(): Promise<
    Pick<
      AgentService,
      | "handleChatCommand"
      | "startChatCommand"
      | "stopChat"
      | "cancelRun"
      | "resumeRun"
      | "retryRun"
      | "approve"
      | "reject"
    >
  >;
  database: DatabaseContext;
}

/**
 * JSON-RPC 路由器 — daemon 的命令分发中枢。
 */
export class JsonRpcRouter {
  constructor(private readonly deps: JsonRpcRouterDeps) {}

  async handle(
    command: JsonRpcCommand,
    ctx: JsonRpcConnectionContext,
  ): Promise<JsonRpcRouterResponse> {
    switch (command.method) {
      case "chat.send": {
        const agent = await this.deps.getChatAgent();
        const params = chatSendSchema.parse(command.params ?? {});
        const conversationId = params.conversationId;

        // Fast ack: startChatCommand returns immediately after creating
        // conversation/message/run. Agent Loop executes in background.
        // All progress delivered via agent.* event notifications.
        const accepted = await agent.startChatCommand(
          {
            conversationId,
            message: params.message,
            mode: params.mode,
            permissionMode: params.permissionMode,
            modelId: params.modelId,
            clientRequestId: params.clientRequestId,
            attachments: params.attachments,
          },
          {
            source: ctx.source,
            connectionId: ctx.connectionId,
          },
          {
            onDelta: (delta) => {
              const method = delta.type;
              ctx.notify({
                jsonrpc: "2.0",
                method,
                params: {
                  eventId: `evt_${crypto.randomUUID()}`,
                  sequence: -1,
                  runId: delta.runId,
                  conversationId: delta.conversationId,
                  createdAt: new Date().toISOString(),
                  payload:
                    method === "agent.message.part.delta"
                      ? {
                          runId: delta.runId,
                          conversationId: delta.conversationId,
                          messageId: delta.messageId,
                          partId: delta.partId,
                          delta: delta.delta,
                          deltaIndex: delta.deltaIndex,
                        }
                      : {
                          runId: delta.runId,
                          conversationId: delta.conversationId,
                          messageId: delta.messageId,
                          delta: delta.delta,
                        },
                },
              });
            },
            onEvent: (event) => {
              ctx.notify({
                jsonrpc: "2.0",
                method: event.type,
                params: agentEventParams(event),
              });
            },
            onError: (error) => {
              ctx.notify(agentErrorNotification(error, conversationId));
            },
          },
        );

        return {
          result: {
            accepted: true,
            conversationId: accepted.conversationId,
            runId: accepted.runId,
            messageId: accepted.messageId,
          },
        };
      }

      case "ping":
        ctx.notify({ jsonrpc: "2.0", method: "pong", params: {} });
        return { result: { ok: true } };

      case "conversation.subscribe": {
        const params = conversationSubscribeSchema.parse(command.params ?? {});
        ctx.conversationSubscriptions.add(params.conversationId);
        const events = params.replayMissedEvents && this.deps.database.events.listByConversationId
          ? await this.deps.database.events.listByConversationId(
              params.conversationId,
              params.lastSeenSequence ?? 0,
            )
          : [];
        for (const event of events) {
          ctx.notify(websocketNotificationForEvent(event));
        }
        const latestSequence = events.reduce(
          (latest, event) => Math.max(latest, event.sequence ?? 0),
          params.lastSeenSequence ?? 0,
        );
        return {
          result: {
            conversationId: params.conversationId,
            subscribed: true,
            replayed: events.length,
            latestSequence,
          },
        };
      }

      case "conversation.unsubscribe": {
        const params = conversationUnsubscribeSchema.parse(
          command.params ?? {},
        );
        ctx.conversationSubscriptions.delete(params.conversationId);
        return {
          result: { conversationId: params.conversationId, subscribed: false },
        };
      }

      case "chat.stop": {
        const { runId } = chatStopSchema.parse(command.params ?? {});
        const agent = await this.deps.getChatAgent();
        return { result: agent.stopChat(runId) };
      }

      case "approval.approve": {
        const { approvalId, actor } = approvalDecideSchema.parse(
          command.params ?? {},
        );
        const agent = await this.deps.getChatAgent();
        return { result: await agent.approve(approvalId, actor) };
      }

      case "approval.reject": {
        const { approvalId, actor, reason, strategy } =
          approvalRejectSchema.parse(command.params ?? {});
        const agent = await this.deps.getChatAgent();
        return {
          result: await agent.reject(approvalId, actor, reason, strategy),
        };
      }

      case "run.subscribe": {
        const params = runSubscribeSchema.parse(command.params ?? {});
        const runId = params.runId ?? "*";
        ctx.runSubscriptions.add(runId);
        const events =
          runId === "*" ? [] : await this.deps.database.events.listByRunId(runId);
        return { result: { runId, events } };
      }

      case "run.unsubscribe": {
        const params = runUnsubscribeSchema.parse(command.params ?? {});
        const runId = params.runId ?? "*";
        ctx.runSubscriptions.delete(runId);
        return { result: { runId, subscribed: false } };
      }

      case "run.cancel": {
        const { runId } = runCancelSchema.parse(command.params ?? {});
        const agent = await this.deps.getChatAgent();
        return {
          result: await agent.cancelRun(runId, "cancelled by user"),
        };
      }

      case "run.resume": {
        const { runId, message, attachments } = runResumeSchema.parse(command.params ?? {});
        const agent = await this.deps.getChatAgent();
        return { result: await agent.resumeRun(runId, message, attachments) };
      }

      case "run.retry": {
        const { runId } = runRetrySchema.parse(command.params ?? {});
        const agent = await this.deps.getChatAgent();
        return { result: await agent.retryRun(runId) };
      }

      default:
        return {
          error: {
            code: JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND,
            message: "Method not found",
          },
        };
    }
  }
}
