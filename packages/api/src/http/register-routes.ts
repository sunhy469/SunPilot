import { createReadStream, existsSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  approvalDecisionSchema,
  AuditActor,
  type ArtifactRecord,
  type MemoryRecord,
} from "@sunpilot/protocol";
import {
  parseAgentChatRequest,
  RuntimeError,
} from "@sunpilot/core";
import {
  readSunPilotConfig,
  updateSunPilotConfig,
} from "@sunpilot/storage";
import type { SunPilotApiDeps } from "../composition/api-deps.js";
import {
  listRunsQuerySchema,
  memorySearchQuerySchema,
  memoryCreateBodySchema,
  memoryUpdateBodySchema,
  listConversationsQuerySchema,
  conversationEventsQuerySchema,
  listApprovalsQuerySchema,
  listAuditLogsQuerySchema,
} from "./schemas.js";

function chatHttpStatus(error: unknown): number {
  if (error instanceof RuntimeError) return error.statusCode;
  if (
    error instanceof Error &&
    (error.message.includes("request must be an object") ||
      error.message.includes("message is required") ||
      error.message.includes("conversationId must be"))
  ) {
    return 400;
  }
  return 500;
}

function conversationTitleFromBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return undefined;
  const title = (body as { title?: unknown }).title;
  if (title === undefined) return undefined;
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("title must be a non-empty string when provided.");
  }
  return title.trim();
}

function paginationCursor(input: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function formatZodIssues(error: ZodError): string {
  return error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
}

/**
 * 注册 SunPilot 全部 HTTP API 路由。
 * daemon 的 server.ts 调用此函数挂载 API，传入 SunPilotApiDeps。
 */
export function registerSunPilotApiRoutes(
  app: FastifyInstance,
  deps: SunPilotApiDeps,
): void {
  const { database, paths, getChatAgent, skills, config } = deps;

  // ── Health ─────────────────────────────────────────────────────────
  app.get("/healthz", async () => ({
    ok: true,
    product: "SunPilot",
    daemon: "alive",
  }));

  app.get("/readyz", async () => ({
    ok: true,
    database: true,
    config: config.read(),
    storage: {},
    skills: skills.list().length,
  }));

  // ── Config ─────────────────────────────────────────────────────────
  app.get("/v1/config", async () => config.read());
  app.patch("/v1/config", async (request) => {
    const updated = config.update(request.body ?? {});
    await database.audit.create({
      actor: AuditActor.LocalUser,
      action: "config.update",
      target: "config.json",
      payload: updated as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    });
    return updated;
  });

  // ── Chat ───────────────────────────────────────────────────────────
  app.post("/v1/chat", async (request, reply) => {
    try {
      const body = parseAgentChatRequest(request.body);
      let assistantContent = "";
      const result = await (
        await getChatAgent()
      ).handleChatCommand(
        {
          conversationId: body.conversationId,
          message: body.message,
          mode: "agent",
        },
        { source: "api" },
        {
          onDelta: (delta) => {
            assistantContent += delta.delta;
          },
        },
      );
      return {
        conversationId: result.conversationId,
        message: {
          id: result.messageId,
          conversationId: result.conversationId,
          role: "assistant",
          content: assistantContent,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof RuntimeError) {
        return reply
          .code(error.statusCode)
          .send({ error: error.code, message: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(chatHttpStatus(error)).send({
        error: chatHttpStatus(error) === 400 ? "bad_request" : "internal_error",
        message,
      });
    }
  });

  // ── Conversations ──────────────────────────────────────────────────
  app.get("/v1/conversations", async (request) => {
    const query = listConversationsQuerySchema.parse(request.query);
    const conversations = await database.conversations.list({
      limit: query.limit + 1,
      cursor: query.cursor,
    });
    const items = conversations.slice(0, query.limit);
    const next = conversations.length > query.limit ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: next
        ? paginationCursor({ updatedAt: next.updatedAt, id: next.id })
        : undefined,
    };
  });
  app.post("/v1/conversations", async (request) =>
    database.conversations.create({
      title: conversationTitleFromBody(request.body),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      const conversation = await database.conversations.findById(
        request.params.id,
      );
      if (!conversation) return reply.code(404).send({ error: "not_found" });
      return conversation;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id/messages",
    async (request, reply) => {
      const conversation = await database.conversations.findById(
        request.params.id,
      );
      if (!conversation) return reply.code(404).send({ error: "not_found" });
      return {
        conversationId: request.params.id,
        items: await database.messages.listByConversationId(request.params.id),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id/events",
    async (request, reply) => {
      if (!database.events.listByConversationId) {
        return reply.code(501).send({ error: "not_implemented" });
      }
      const query = conversationEventsQuerySchema.parse(request.query);
      const events = await database.events.listByConversationId(
        request.params.id,
        query.afterSequence ?? 0,
      );
      return {
        conversationId: request.params.id,
        items: query.limit ? events.slice(0, query.limit) : events,
      };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      const deleted = await database.conversations.delete(request.params.id);
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );

  // ── Runs ───────────────────────────────────────────────────────────
  app.get("/v1/runs", async (request) => {
    const query = listRunsQuerySchema.parse(request.query);
    const runs = await database.runs.list({
      status: query.status,
      mode: query.mode,
      conversationId: query.conversationId,
      limit: query.limit + 1,
      cursor: query.cursor,
    });
    const items = runs.slice(0, query.limit);
    const next = runs.length > query.limit ? items.at(-1) : undefined;
    return {
      items,
      nextCursor: next
        ? paginationCursor({ updatedAt: next.updatedAt, id: next.id })
        : undefined,
    };
  });
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id",
    async (request, reply) => {
      const run = await database.runs.findById(request.params.id);
      if (!run) return reply.code(404).send({ error: "not_found" });
      return {
        ...run,
        steps: await database.steps.listByRunId(run.id),
        events: await database.events.listByRunId(run.id),
        artifacts: await database.artifacts.list(run.id),
        memory: await database.memory.search({ runId: run.id }),
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/events",
    async (request) => ({
      runId: request.params.id,
      items: await database.events.listByRunId(request.params.id),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/status-history",
    async (request) => ({
      runId: request.params.id,
      items: await database.runStatusHistory.listByRunId(request.params.id),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/tool-calls",
    async (request) => ({
      runId: request.params.id,
      items: await database.toolCalls.listByRunId(request.params.id),
    }),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/model-calls",
    async (request) => ({
      runId: request.params.id,
      items: await database.modelCalls.listByRunId(request.params.id),
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { key?: string } }>(
    "/v1/runs/:id/memory",
    async (request) =>
      database.memory.search({
        runId: request.params.id,
        key: request.query.key,
      }),
  );

  // ── Run actions ────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/cancel",
    async (request) => {
      const agent = await getChatAgent();
      return agent.cancelRun(request.params.id, "cancelled by user");
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/retry",
    async (request) => {
      const agent = await getChatAgent();
      return agent.retryRun(request.params.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/resume",
    async (request, reply) => {
      const agent = await getChatAgent();
      try {
        return await agent.resumeRun(request.params.id);
      } catch (error) {
        if ((error as { code?: string }).code === "AGENT_RUN_NOT_FOUND") {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );

  // ── Memory ─────────────────────────────────────────────────────────
  app.post("/v1/memory", async (request, reply) => {
    try {
      const body = memoryCreateBodySchema.parse(request.body ?? {});
      const now = new Date().toISOString();
      const memory = await database.memory.create({
        id: body.id ?? `memory_${crypto.randomUUID()}`,
        runId: body.runId,
        stepId: body.stepId,
        key: body.key,
        value: body.value ?? body.content ?? "",
        scope: body.scope,
        scopeId: body.scopeId,
        type: body.type,
        title: body.title,
        content: body.content,
        summary: body.summary,
        source: body.source ?? "api",
        confidence: body.confidence,
        importance: body.importance,
        metadata: body.metadata ?? {},
        createdAt: body.createdAt ?? now,
        updatedAt: body.updatedAt ?? now,
        expiresAt: body.expiresAt,
      });
      return { item: memory };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: "bad_request",
          message: formatZodIssues(error),
        });
      }
      throw error;
    }
  });
  app.patch<{ Params: { id: string } }>(
    "/v1/memory/:id",
    async (request, reply) => {
      try {
        const body = memoryUpdateBodySchema.parse(request.body ?? {});
        const updated = await database.memory.update(request.params.id, {
          key: body.key,
          value: body.value,
          scope: body.scope,
          scopeId: body.scopeId,
          type: body.type,
          title: body.title,
          content: body.content,
          summary: body.summary,
          source: body.source,
          confidence: body.confidence,
          importance: body.importance,
          metadata: body.metadata,
          expiresAt: body.expiresAt,
        });
        if (!updated) return reply.code(404).send({ error: "not_found" });
        return { item: updated };
      } catch (error) {
        if (error instanceof ZodError) {
          return reply.code(400).send({
            error: "bad_request",
            message: formatZodIssues(error),
          });
        }
        throw error;
      }
    },
  );
  app.delete<{ Params: { id: string }; Body: { reason?: string } }>(
    "/v1/memory/:id",
    async (request) => {
      await database.memory.softDelete(
        request.params.id,
        request.body?.reason ?? "deleted via api",
      );
      return { ok: true, id: request.params.id };
    },
  );
  app.get("/v1/memory", async (request) => {
    const query = memorySearchQuerySchema.parse(request.query);
    return {
      items: await database.memory.search({
        query: query.query,
        runId: query.runId,
        key: query.key,
        userId: query.userId,
        projectId: query.projectId,
        conversationId: query.conversationId,
        scopes: query.scope ? [query.scope] : undefined,
        types: query.type ? [query.type] : undefined,
        includeDeleted: query.includeDeleted,
        limit: query.limit,
      }),
    };
  });

  // ── Skills ─────────────────────────────────────────────────────────
  app.get("/v1/skills", async () => database.skills.list());
  app.get<{ Params: { id: string } }>(
    "/v1/skills/:id",
    async (request, reply) => {
      const skill = await database.skills.findById(request.params.id);
      return skill ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.post("/v1/skills/reload", async () => skills.reload());
  app.post<{ Params: { id: string } }>(
    "/v1/skills/:id/enable",
    async (request, reply) => {
      const result = await skills.setEnabled(request.params.id, true);
      return result ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/skills/:id/disable",
    async (request, reply) => {
      const result = await skills.setEnabled(request.params.id, false);
      return result ?? reply.code(404).send({ error: "not_found" });
    },
  );

  // ── Approvals ──────────────────────────────────────────────────────
  app.get("/v1/approvals", async (request) => {
    const query = listApprovalsQuerySchema.parse(request.query);
    return {
      items: await database.approvals.list({
        status: query.status,
        runId: query.runId,
        limit: query.limit,
      }),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/v1/approvals/:id/approve",
    async (request, reply) => {
      const decision = approvalDecisionSchema.parse(request.body ?? {});
      const agent = await getChatAgent();
      try {
        return await agent.approve(request.params.id, decision.actor);
      } catch (error) {
        if ((error as { code?: string }).code === "AGENT_APPROVAL_NOT_RESUMABLE") {
          return reply.code(409).send({
            error: "approval_not_resumable",
            message:
              error instanceof Error ? error.message : "Approval is not resumable.",
          });
        }
        throw error;
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/approvals/:id/reject",
    async (request) => {
      const decision = approvalDecisionSchema.parse(request.body ?? {});
      const agent = await getChatAgent();
      return agent.reject(
        request.params.id,
        decision.actor,
        decision.reason,
      );
    },
  );

  // ── Artifacts ──────────────────────────────────────────────────────
  app.get<{ Querystring: { runId?: string } }>(
    "/v1/artifacts",
    async (request) => database.artifacts.list(request.query.runId),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/artifacts/:id",
    async (request, reply) => {
      const artifact = await database.artifacts.findById(
        request.params.id,
      ) as ArtifactRecord | null;
      return artifact ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/artifacts/:id/content",
    async (request, reply) => {
      const artifact = await database.artifacts.findById(
        request.params.id,
      ) as ArtifactRecord | null;
      if (!artifact) return reply.code(404).send({ error: "not_found" });
      if (!existsSync(artifact.path) || !statSync(artifact.path).isFile()) {
        return reply.code(404).send({ error: "artifact_content_missing" });
      }
      return reply
        .type(artifact.mimeType ?? "application/octet-stream")
        .send(createReadStream(artifact.path));
    },
  );

  // ── Audit ──────────────────────────────────────────────────────────
  app.get("/v1/audit-logs", async (request) => {
    const query = listAuditLogsQuerySchema.parse(request.query);
    const items = await database.audit.list(query.runId);
    return query.limit ? items.slice(0, query.limit) : items;
  });
}
