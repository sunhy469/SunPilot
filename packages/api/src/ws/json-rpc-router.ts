import type { AgentService } from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import {
  approvalDecideSchema,
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
        const result = await agent.handleChatCommand(
          {
            conversationId,
            message: params.message,
            mode: params.mode,
            clientRequestId: params.clientRequestId,
            attachments: params.attachments,
          },
          {
            source: ctx.source,
            connectionId: ctx.connectionId,
          },
          {
            onDelta: (delta) => {
              ctx.notify({
                jsonrpc: "2.0",
                method: "agent.response.delta",
                params: {
                  eventId: `evt_${crypto.randomUUID()}`,
                  sequence: -1,
                  conversationId: delta.conversationId,
                  createdAt: new Date().toISOString(),
                  payload: {
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
            conversationId: result.conversationId,
            runId: result.runId,
            messageId: result.messageId,
          },
        };
      }

      case "ping":
        ctx.notify({ jsonrpc: "2.0", method: "pong", params: {} });
        return { result: { ok: true } };

      case "conversation.subscribe": {
        const params = conversationSubscribeSchema.parse(command.params ?? {});
        ctx.conversationSubscriptions.add(params.conversationId);
        const events = this.deps.database.events.listByConversationId
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
        const { approvalId, actor, reason } = approvalDecideSchema.parse(
          command.params ?? {},
        );
        const agent = await this.deps.getChatAgent();
        return { result: await agent.reject(approvalId, actor, reason) };
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
        const { runId } = runResumeSchema.parse(command.params ?? {});
        const agent = await this.deps.getChatAgent();
        return { result: await agent.resumeRun(runId) };
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
