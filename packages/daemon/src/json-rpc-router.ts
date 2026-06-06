import type { AgentService } from "@sunpilot/core";
import type { DatabaseContext } from "@sunpilot/storage";
import type { RepositoryRuntimeStore, SunPilotRuntime } from "@sunpilot/core";
import {
  approvalDecideSchema,
  chatSendSchema,
  chatStopSchema,
  conversationSubscribeSchema,
  conversationUnsubscribeSchema,
  createRunSchema,
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
  runtime: SunPilotRuntime;
  runtimeStore: RepositoryRuntimeStore;
}

export class JsonRpcRouter {
  constructor(private readonly deps: JsonRpcRouterDeps) {}

  async handle(
    command: JsonRpcCommand,
    ctx: JsonRpcConnectionContext,
  ): Promise<JsonRpcRouterResponse> {
    switch (command.method) {
      case "run.create": {
        const body = createRunSchema.parse(command.params ?? {});
        return {
          result: await this.deps.runtime.createRun(
            body.input,
            body.workflowId,
            body.mode,
          ),
        };
      }

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
          runId === "*" ? [] : await this.deps.runtimeStore.listEvents(runId);
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
        try {
          return {
            result: await agent.cancelRun(runId, "cancelled by user"),
          };
        } catch (error) {
          if ((error as { code?: string }).code !== "AGENT_RUN_NOT_FOUND") {
            throw error;
          }
          const run = await this.deps.runtime.cancel(runId);
          return { result: { cancelled: true, runId, run } };
        }
      }

      case "run.resume": {
        const { runId } = runResumeSchema.parse(command.params ?? {});
        const agent = await this.deps.getChatAgent();
        return { result: await agent.resumeRun(runId) };
      }

      case "run.retry": {
        const { runId } = runRetrySchema.parse(command.params ?? {});
        const agent = await this.deps.getChatAgent();
        try {
          return { result: await agent.retryRun(runId) };
        } catch (error) {
          if ((error as { code?: string }).code !== "AGENT_RUN_NOT_FOUND") {
            throw error;
          }
          return { result: await this.deps.runtime.retry(runId) };
        }
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
