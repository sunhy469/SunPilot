import { createReadStream, existsSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import {
  approvalDecisionSchema,
  type MemoryRecord,
  type RunMode,
  type RunStatus,
  type WorkflowRecord,
} from "@sunpilot/protocol";
import {
  parseAgentChatRequest,
  RuntimeError,
  type AgentService,
  type RepositoryApprovalExpiryService,
  type RepositoryRuntimeStore,
  type SunPilotRuntime,
} from "@sunpilot/core";
import {
  readSunPilotConfig,
  updateSunPilotConfig,
  type DatabaseContext,
  type SunPilotPaths,
} from "@sunpilot/storage";

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

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function paginationCursor(input: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function parseRunStatus(value: string | undefined): RunStatus | undefined {
  if (!value) return undefined;
  const statuses: readonly RunStatus[] = [
    "created",
    "queued",
    "context_building",
    "intent_routing",
    "planning",
    "tool_deciding",
    "waiting_approval",
    "executing",
    "observing",
    "reflecting",
    "responding",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ];
  return statuses.includes(value as RunStatus)
    ? (value as RunStatus)
    : undefined;
}

function parseRunMode(value: string | undefined): RunMode | undefined {
  if (!value) return undefined;
  const modes: readonly RunMode[] = ["chat", "agent", "workflow"];
  return modes.includes(value as RunMode) ? (value as RunMode) : undefined;
}

function parseApprovalStatus(
  value: string | undefined,
): "pending" | "approved" | "rejected" | "expired" | undefined {
  if (
    value === "pending" ||
    value === "approved" ||
    value === "rejected" ||
    value === "expired"
  ) {
    return value;
  }
  return undefined;
}

interface SkillRegistryRoutes {
  reload(): Promise<unknown>;
  list(): unknown[];
  setEnabled(id: string, enabled: boolean): Promise<unknown>;
}

interface WorkflowRoutes {
  records(): WorkflowRecord[];
  list(): unknown[];
}

export function registerDaemonRoutes(
  app: FastifyInstance,
  deps: {
    database: DatabaseContext;
    paths: SunPilotPaths;
    duckDb: unknown;
    lanceDb: unknown;
    runtime: Pick<SunPilotRuntime, "interrupt" | "listCapabilities">;
    runtimeStore: RepositoryRuntimeStore;
    approvalExpiryService: RepositoryApprovalExpiryService;
    workflows: WorkflowRoutes;
    skillRegistry: SkillRegistryRoutes;
    getChatAgent: () => Promise<AgentService>;
  },
): void {
  const {
    database,
    paths,
    duckDb,
    lanceDb,
    runtime,
    runtimeStore,
    approvalExpiryService,
    workflows,
    skillRegistry,
    getChatAgent,
  } = deps;

  app.get("/healthz", async () => ({
    ok: true,
    product: "SunPilot",
    daemon: "alive",
  }));

  app.get("/readyz", async () => ({
    ok: true,
    database: true,
    config: readSunPilotConfig(paths),
    storage: { duckDb, lanceDb },
    skills: skillRegistry.list().length,
    workflows: workflows.list().length,
  }));

  app.get("/v1/config", async () => readSunPilotConfig(paths));
  app.patch("/v1/config", async (request) => {
    const updated = updateSunPilotConfig(
      request.body as Parameters<typeof updateSunPilotConfig>[0],
      paths,
    );
    await runtimeStore.audit({
      actor: "local-user",
      action: "config.update",
      target: "config.json",
      payload: updated,
    });
    return updated;
  });

  app.post("/v1/runs", async (_request, reply) =>
    reply.code(410).send({
      error: "legacy_runtime_removed",
      message:
        "POST /v1/runs has been removed. Start Agent runs through /v1/chat or WebSocket chat.send.",
    }),
  );

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

  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/v1/conversations",
    async (request) => {
      const limit = parsePositiveInt(request.query.limit) ?? 50;
      const conversations = await database.conversations.list({
        limit: limit + 1,
        cursor: request.query.cursor,
      });
      const items = conversations.slice(0, limit);
      const next = conversations.length > limit ? items.at(-1) : undefined;
      return {
        items,
        nextCursor: next
          ? paginationCursor({ updatedAt: next.updatedAt, id: next.id })
          : undefined,
      };
    },
  );
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
  app.get<{
    Params: { id: string };
    Querystring: { afterSequence?: string; limit?: string };
  }>("/v1/conversations/:id/events", async (request, reply) => {
    if (!database.events.listByConversationId) {
      return reply.code(501).send({ error: "not_implemented" });
    }
    const events = await database.events.listByConversationId(
      request.params.id,
      parsePositiveInt(request.query.afterSequence) ?? 0,
    );
    const limit = parsePositiveInt(request.query.limit);
    return {
      conversationId: request.params.id,
      items: limit ? events.slice(0, limit) : events,
    };
  });
  app.delete<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      const deleted = await database.conversations.delete(request.params.id);
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return { ok: true };
    },
  );

  app.get<{
    Querystring: {
      status?: string;
      mode?: string;
      conversationId?: string;
      limit?: string;
      cursor?: string;
    };
  }>("/v1/runs", async (request) => {
    const limit = parsePositiveInt(request.query.limit) ?? 50;
    const runs = await database.runs.list({
      status: parseRunStatus(request.query.status),
      mode: parseRunMode(request.query.mode),
      conversationId: request.query.conversationId,
      limit: limit + 1,
      cursor: request.query.cursor,
    });
    const items = runs.slice(0, limit);
    const next = runs.length > limit ? items.at(-1) : undefined;
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
      const run = await runtimeStore.getRun(request.params.id);
      if (!run) return reply.code(404).send({ error: "not_found" });
      return {
        ...run,
        steps: await runtimeStore.listSteps(run.id),
        events: await runtimeStore.listEvents(run.id),
        artifacts: await runtimeStore.listArtifacts(run.id),
        memory: await runtimeStore.listMemory({ runId: run.id }),
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
      runtimeStore.listMemory({
        runId: request.params.id,
        key: request.query.key,
      }),
  );
  app.post("/v1/memory", async (request, reply) => {
    const body = request.body as Partial<MemoryRecord> | undefined;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "bad_request" });
    }
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!key) return reply.code(400).send({ error: "key_required" });
    const now = new Date().toISOString();
    const memory = await database.memory.create({
      id: body.id ?? `memory_${crypto.randomUUID()}`,
      runId: body.runId,
      stepId: body.stepId,
      key,
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
  });
  app.patch<{ Params: { id: string } }>(
    "/v1/memory/:id",
    async (request, reply) => {
      const body = request.body as Partial<MemoryRecord> | undefined;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "bad_request" });
      }
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
  app.post<{ Params: { id: string } }>(
    "/v1/runs/:id/interrupt",
    async (request) => runtime.interrupt(request.params.id),
  );
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

  app.get("/v1/workflows", async () => database.workflows.list());
  app.get<{ Params: { id: string } }>(
    "/v1/workflows/:id",
    async (request, reply) => {
      const workflow = await database.workflows.findById(request.params.id);
      return workflow ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.post("/v1/workflows/reload", async () => {
    for (const record of workflows.records()) {
      await database.workflows.upsert(record);
    }
    return database.workflows.list();
  });

  app.get("/v1/skills", async () => database.skills.list());
  app.get<{ Params: { id: string } }>(
    "/v1/skills/:id",
    async (request, reply) => {
      const skill = await database.skills.findById(request.params.id);
      return skill ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.post("/v1/skills/reload", async () => skillRegistry.reload());
  app.post<{ Params: { id: string } }>(
    "/v1/skills/:id/enable",
    async (request, reply) => {
      const skill = await skillRegistry.setEnabled(request.params.id, true);
      return skill ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/skills/:id/disable",
    async (request, reply) => {
      const skill = await skillRegistry.setEnabled(request.params.id, false);
      return skill ?? reply.code(404).send({ error: "not_found" });
    },
  );

  app.get<{
    Querystring: { status?: string; runId?: string; limit?: string };
  }>("/v1/approvals", async (request) => ({
    items: await database.approvals.list({
      status: parseApprovalStatus(request.query.status),
      runId: request.query.runId,
      limit: parsePositiveInt(request.query.limit),
    }),
  }));
  app.post("/v1/approvals/expire-stale", async () => ({
    items: await approvalExpiryService.expireStale(),
  }));
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

  app.get<{ Querystring: { runId?: string } }>(
    "/v1/artifacts",
    async (request) => runtimeStore.listArtifacts(request.query.runId),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/artifacts/:id",
    async (request, reply) => {
      const artifact = await runtimeStore.getArtifact(request.params.id);
      return artifact ?? reply.code(404).send({ error: "not_found" });
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/artifacts/:id/content",
    async (request, reply) => {
      const artifact = await runtimeStore.getArtifact(request.params.id);
      if (!artifact) return reply.code(404).send({ error: "not_found" });
      if (!existsSync(artifact.path) || !statSync(artifact.path).isFile()) {
        return reply.code(404).send({ error: "artifact_content_missing" });
      }
      return reply
        .type(artifact.mimeType ?? "application/octet-stream")
        .send(createReadStream(artifact.path));
    },
  );

  app.get<{ Querystring: { runId?: string; limit?: string } }>(
    "/v1/audit-logs",
    async (request) => {
      const items = await database.audit.list(request.query.runId);
      const limit = parsePositiveInt(request.query.limit);
      return limit ? items.slice(0, limit) : items;
    },
  );
  app.get("/v1/jobs", async () => runtimeStore.listJobs());
  app.post("/v1/jobs/expire-timeouts", async () => ({
    expiredRunIds: await runtimeStore.expireTimedOutJobs(),
  }));
  app.get("/v1/capabilities", async () => runtime.listCapabilities());
  app.get<{
    Querystring: {
      query?: string;
      runId?: string;
      key?: string;
      userId?: string;
      projectId?: string;
      conversationId?: string;
      scope?: string;
      type?: string;
      includeDeleted?: string;
      limit?: string;
    };
  }>("/v1/memory", async (request) => ({
    items: await database.memory.search({
      query: request.query.query,
      runId: request.query.runId,
      key: request.query.key,
      userId: request.query.userId,
      projectId: request.query.projectId,
      conversationId: request.query.conversationId,
      scopes: request.query.scope ? [request.query.scope as any] : undefined,
      types: request.query.type ? [request.query.type as any] : undefined,
      includeDeleted: request.query.includeDeleted === "true",
      limit: parsePositiveInt(request.query.limit),
    }),
  }));
}
