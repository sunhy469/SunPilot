import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  approvalDecisionSchema,
  approvalRejectSchema,
  AuditActor,
  type ArtifactRecord,
} from "@sunpilot/protocol";
import {
  parseAgentChatRequest,
  RuntimeError,
  ossNotConfigured,
} from "@sunpilot/core";
import {
  LOCAL_CONTEXT,
  ConversationNotFoundError,
  ConversationHasActiveRunsError,
} from "@sunpilot/platform";
import type { SunPilotApiDeps } from "../composition/api-deps.js";
import {
  listRunsQuerySchema,
  listConversationsQuerySchema,
  conversationEventsQuerySchema,
  listApprovalsQuerySchema,
  listAuditLogsQuerySchema,
  uploadPresignBodySchema,
  updateConversationBodySchema,
} from "./schemas.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerDigitalWorldRoutes } from "./routes/digital-world.js";
import { formatZodIssues, paginationCursor } from "./routes/shared.js";

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

/**
 * 注册 SunPilot 全部 HTTP API 路由。
 * daemon 的 server.ts 调用此函数挂载 API，传入 SunPilotApiDeps。
 */
export function registerSunPilotApiRoutes(
  app: FastifyInstance,
  deps: SunPilotApiDeps,
): void {
  const { database, getChatAgent, skills, config, diagnostics } = deps;

  // ── Health ─────────────────────────────────────────────────────────
  app.get("/healthz", async () => ({
    ok: true,
    product: "SunPilot",
    daemon: "alive",
  }));

  // ── Diagnostics (§API placement) ──────────────────────────────────
  app.get("/v1/diagnostics", async () => {
    const startedAt = Date.now();
    await database.runs.list({ limit: 1 });
    const databaseLatencyMs = Date.now() - startedAt;
    const skillsList = skills.list() as Array<{ enabled: boolean }>;
    const [waitingApproval, waitingUser, running] =
      await Promise.all([
        database.runs.list({ status: "waiting_approval", limit: 200 }),
        database.runs.list({ status: "waiting_user", limit: 200 }),
        database.runs.list({ status: "running", limit: 200 }),
      ]);
    const activeCount = running.length;
    const llmConfig = diagnostics?.getLlmConfig?.() ?? {
      provider: "unknown",
      model: "unknown",
      configured: false,
    };
    const modelRouterStats = diagnostics?.getModelRouterStats?.();
    return {
      daemon: { status: "ok", uptimeSec: Math.floor(process.uptime()), pid: process.pid },
      database: { status: "ok", latencyMs: databaseLatencyMs },
      llm: llmConfig,
      skills: {
        count: skillsList.length,
        enabled: skillsList.filter((s) => s.enabled).length,
      },
      runs: {
        active: activeCount,
        waitingApproval: waitingApproval.length,
        waitingUser: waitingUser.length,
      },
      websocket: { connections: diagnostics?.websocketConnections?.() ?? 0 },
      modelRouter: modelRouterStats,
    };
  });

  app.get("/readyz", async () => ({
    ok: true,
    database: true,
    skills: skills.list().length,
  }));

  // ── Config ─────────────────────────────────────────────────────────
  app.get("/v1/config", async () => config.read());

  // ── Models ─────────────────────────────────────────────────────────
  app.get("/v1/models", async () => {
    const models = deps.getModels?.() ?? [];
    const configuredDefault = deps.getDefaultModelId?.();
    const defaultModelId =
      (configuredDefault && models.some((model) => model.id === configuredDefault && model.available)
        ? configuredDefault
        : models.find((model) => model.available)?.id) ??
      models[0]?.id ??
      "dp";
    return {
      defaultModelId,
      items: models,
    };
  });
  app.patch("/v1/config", async (request) => {
    const before = config.read();
    const updated = config.update(request.body ?? {});
    await database.audit.create({
      actor: AuditActor.LocalUser,
      action: "config.update",
      target: "config.json",
      payload: updated as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    });
    return {
      ...(updated && typeof updated === "object" ? updated as Record<string, unknown> : { config: updated }),
      restartRequired: JSON.stringify(before) !== JSON.stringify(updated),
    };
  });

  // ── Chat ───────────────────────────────────────────────────────────
  app.post("/v1/chat", async (request, reply) => {
    try {
      const body = parseAgentChatRequest(request.body);
      let assistantContent = "";
      // A5: Abort the agent loop when the HTTP client disconnects so the
      // server stops LLM/skill work for a gone client instead of running
      // to completion and discarding the result.
      const abortController = new AbortController();
      const onClose = () => abortController.abort();
      request.raw.on("close", onClose);
      const onFinished = () => {
        request.raw.off("close", onClose);
      };
      reply.raw.on("finish", onFinished);
      reply.raw.on("close", onFinished);
      try {
        const result = await (
          await getChatAgent()
        ).handleChatCommand(
          {
            conversationId: body.conversationId,
            message: body.message,
            mode: "agent",
            attachments: body.attachments,
          },
          { source: "api" },
          {
            onDelta: (delta) => {
              assistantContent += delta.delta;
            },
            signal: abortController.signal,
          },
        );
        return {
          conversationId: result.conversationId,
          message: {
            id: result.messageId,
            conversationId: result.conversationId,
            role: "assistant",
            content: result.assistantContent ?? assistantContent,
            createdAt: new Date().toISOString(),
          },
        };
      } finally {
        onFinished();
      }
    } catch (error) {
      if (error instanceof RuntimeError) {
        if (error.statusCode >= 500) {
          request.log.error({ err: error }, "Runtime error in /v1/chat");
          return reply.code(error.statusCode).send({
            error: error.code,
            message: "An internal server error occurred.",
          });
        }
        return reply
          .code(error.statusCode)
          .send({ error: error.code, message: error.message });
      }
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: "bad_request",
          message: "Request validation failed.",
          issues: error.issues,
        });
      }
      // Internal errors: log server-side, return generic message to client.
      request.log.error(
        { err: error },
        "Unhandled error in /v1/chat",
      );
      return reply.code(500).send({
        error: "internal_error",
        message: "An internal server error occurred.",
      });
    }
  });

  // ── Conversations ──────────────────────────────────────────────────
  const { conversations } = deps.platform;

  app.get("/v1/conversations", async (request) => {
    const query = listConversationsQuerySchema.parse(request.query);
    return conversations.listConversations(LOCAL_CONTEXT, {
      limit: query.limit,
      cursor: query.cursor,
    });
  });
  app.post("/v1/conversations", async (request) =>
    conversations.createConversation(
      LOCAL_CONTEXT,
      conversationTitleFromBody(request.body),
    ),
  );
  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      try {
        return await conversations.getConversation(
          LOCAL_CONTEXT,
          request.params.id,
        );
      } catch (error) {
        if (error instanceof ConversationNotFoundError) {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );
  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id/messages",
    async (request, reply) => {
      try {
        return await conversations.listMessages(
          LOCAL_CONTEXT,
          request.params.id,
        );
      } catch (error) {
        if (error instanceof ConversationNotFoundError) {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
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
  app.get<{ Params: { id: string } }>(
    "/v1/conversations/:id/active-run",
    async (request, reply) => {
      try {
        return await conversations.getActiveRun(
          LOCAL_CONTEXT,
          request.params.id,
        );
      } catch (error) {
        if (error instanceof ConversationNotFoundError) {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      const body = updateConversationBodySchema.parse(request.body ?? {});
      try {
        return await conversations.updateConversation(
          LOCAL_CONTEXT,
          request.params.id,
          body,
        );
      } catch (error) {
        if (error instanceof ConversationNotFoundError) {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    "/v1/conversations/:id/touch",
    async (request, reply) => {
      try {
        return await conversations.touchConversation(
          LOCAL_CONTEXT,
          request.params.id,
        );
      } catch (error) {
        if (error instanceof ConversationNotFoundError) {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/v1/conversations/:id",
    async (request, reply) => {
      try {
        return await conversations.deleteConversation(
          LOCAL_CONTEXT,
          request.params.id,
        );
      } catch (error) {
        if (error instanceof ConversationNotFoundError) {
          return reply.code(404).send({ error: "not_found" });
        }
        if (error instanceof ConversationHasActiveRunsError) {
          return reply.code(409).send({
            error: {
              code: "CONVERSATION_HAS_ACTIVE_RUNS",
              message: error.message,
              activeRunCount: error.activeRunCount,
            },
          });
        }
        throw error;
      }
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

  // ── Context snapshot debug API ─────────────────────────────────────
  // Returns the context snapshots for all model calls in a run.
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/context",
    async (request, reply) => {
      const modelCalls = await database.modelCalls.listByRunId(request.params.id);
      const snapshots = modelCalls
        .filter((mc) => mc.metadata?.context)
        .map((mc) => ({
          modelCallId: mc.id,
          purpose: mc.purpose,
          model: mc.model,
          provider: mc.provider,
          status: mc.status,
          createdAt: mc.createdAt,
          context: mc.metadata!.context,
        }));
      if (snapshots.length === 0) {
        return reply.code(404).send({
          error: "not_found",
          message: "No context snapshots found for this run.",
        });
      }
      return { runId: request.params.id, snapshots };
    },
  );

  // Returns the context snapshot for a specific model call.
  app.get<{ Params: { id: string } }>(
    "/v1/model-calls/:id/context",
    async (request, reply) => {
      const mc = await database.modelCalls.findById(request.params.id);
      if (!mc) return reply.code(404).send({ error: "not_found" });
      if (!mc.metadata?.context) {
        return reply.code(404).send({
          error: "not_found",
          message: "No context snapshot for this model call.",
        });
      }
      return {
        modelCallId: mc.id,
        purpose: mc.purpose,
        model: mc.model,
        provider: mc.provider,
        status: mc.status,
        createdAt: mc.createdAt,
        context: mc.metadata.context,
      };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { key?: string } }>(
    "/v1/runs/:id/memory",
    async (request) =>
      database.memory.search({
        runId: request.params.id,
        key: request.query.key,
      }),
  );

  // ── Trace debug endpoint (§P1-6) ────────────────────────────────────
  app.get<{ Params: { id: string } }>(
    "/v1/runs/:id/trace",
    async (request, reply) => {
      const runId = request.params.id;
      const run = await database.runs.findById(runId);
      if (!run) return reply.code(404).send({ error: "not_found" });

      // Collect all observability data for this run
      const [events, modelCalls, toolCalls, approvals, statusHistory] =
        await Promise.all([
          database.events.listByRunId(runId),
          database.modelCalls.listByRunId(runId),
          database.toolCalls.listByRunId(runId),
          database.approvals.list({ runId }),
          database.runStatusHistory.listByRunId(runId),
        ]);

      // Load trace/spans from DB if available (§P0-2)
      let trace = null;
      let spans: Array<Record<string, unknown>> = [];
      if (database.agentTraces) {
        const dbTrace = await database.agentTraces.findByRunId(runId);
        if (dbTrace) {
          trace = dbTrace;
          const dbSpans = await database.agentTraces.listSpansByRunId(runId);
          spans = dbSpans.map((s) => ({
            id: s.id,
            kind: s.kind,
            summary: s.summary,
            startMs: s.startMs,
            endMs: s.endMs,
            durationMs: s.durationMs,
            tokenInput: s.tokenInput,
            tokenOutput: s.tokenOutput,
            toolCallsCount: s.toolCallsCount,
            toolFailures: s.toolFailures,
            modelCallsCount: s.modelCallsCount,
            error: s.error,
            // §P0-3: Sub-phase timing metrics from span metadata JSONB
            contextGroupAMs: (s.metadata as Record<string, unknown>)?.contextGroupAMs,
            summaryGenerationMs: (s.metadata as Record<string, unknown>)?.summaryGenerationMs,
            summaryProcessingMs: (s.metadata as Record<string, unknown>)?.summaryProcessingMs,
            historyProcessingMs: (s.metadata as Record<string, unknown>)?.historyProcessingMs,
            memorySearchMs: (s.metadata as Record<string, unknown>)?.memorySearchMs,
            sourceCompressionMs: (s.metadata as Record<string, unknown>)?.sourceCompressionMs,
            tokenBudgetMs: (s.metadata as Record<string, unknown>)?.tokenBudgetMs,
            contextAssemblyMs: (s.metadata as Record<string, unknown>)?.contextAssemblyMs,
            intentRouteMs: (s.metadata as Record<string, unknown>)?.intentRouteMs,
            layer0FormMatchMs: (s.metadata as Record<string, unknown>)?.layer0FormMatchMs,
            layer1QueryEmbedMs: (s.metadata as Record<string, unknown>)?.layer1QueryEmbedMs,
            layer1SkillEmbedMs: (s.metadata as Record<string, unknown>)?.layer1SkillEmbedMs,
            layer2LlmMs: (s.metadata as Record<string, unknown>)?.layer2LlmMs,
            layer2TtftMs: (s.metadata as Record<string, unknown>)?.layer2TtftMs,
            toolRetrievalMs: (s.metadata as Record<string, unknown>)?.toolRetrievalMs,
            firstTokenMs: (s.metadata as Record<string, unknown>)?.firstTokenMs,
            toolExecutionMs: (s.metadata as Record<string, unknown>)?.toolExecutionMs,
            finalTokenMs: (s.metadata as Record<string, unknown>)?.finalTokenMs,
          }));
        }
      }

      // Load plan snapshots if available (§P0-2)
      let planSnapshots: Array<Record<string, unknown>> = [];
      if (database.planSnapshots) {
        const snapshots = await database.planSnapshots.listByRunId(runId);
        planSnapshots = snapshots.map((s) => ({
          id: s.id,
          version: s.version,
          eventType: s.eventType,
          diffSummary: s.diffSummary,
          trigger: s.trigger,
          addedSteps: s.addedSteps,
          removedSteps: s.removedSteps,
          modifiedSteps: s.modifiedSteps,
          createdAt: s.createdAt,
        }));
      }

      // Build merged trace view
      return {
        runId,
        conversationId: run.conversationId,
        status: run.status,
        mode: run.mode,
        activePlan: run.activePlanJson ?? null,
        planRevisionCount: run.planRevisionCount ?? 0,
        trace,
        spans,
        planSnapshots,
        timeline: {
          statusHistory: statusHistory.map((h) => ({
            from: h.previousStatus,
            to: h.nextStatus,
            reason: h.reason,
            at: h.createdAt,
          })),
          events: events.map((e) => ({
            type: e.type,
            sequence: e.sequence,
            at: e.createdAt,
          })),
        },
        modelCalls: modelCalls.map((mc) => ({
          id: mc.id,
          provider: mc.provider,
          model: mc.model,
          purpose: mc.purpose,
          status: mc.status,
          inputTokens: mc.inputTokens,
          outputTokens: mc.outputTokens,
          latencyMs: mc.latencyMs,
          firstTokenMs: (mc.metadata as Record<string, unknown>)?.firstTokenMs,
          error: mc.error,
        })),
        toolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          skillId: tc.skillId,
          name: tc.name,
          status: tc.status,
          riskLevel: tc.riskLevel,
          metadata: tc.metadata,
          startedAt: tc.startedAt,
          completedAt: tc.completedAt,
        })),
        approvals: approvals.map((a) => ({
          id: a.id,
          title: a.title,
          status: a.status,
          risk: a.risk,
          decidedBy: a.decidedBy,
        })),
      };
    },
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
  app.post<{
    Params: { id: string };
    Body: {
      message?: string;
      attachments?: import("@sunpilot/core").AttachmentRef[];
    };
  }>(
    "/v1/runs/:id/resume",
    async (request, reply) => {
      const agent = await getChatAgent();
      try {
        return await agent.resumeRun(
          request.params.id,
          request.body?.message,
          request.body?.attachments,
        );
      } catch (error) {
        if ((error as { code?: string }).code === "AGENT_RUN_NOT_FOUND") {
          return reply.code(404).send({ error: "not_found" });
        }
        throw error;
      }
    },
  );

  // ── Memory (see routes/memory.ts) ──────────────────────────────────
  registerMemoryRoutes(app, deps);
  registerDigitalWorldRoutes(app, deps);

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
        conversationId: query.conversationId,
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
      const decision = approvalRejectSchema.parse({
        ...(request.body ?? {}),
        approvalId: request.params.id,
      });
      const agent = await getChatAgent();
      return agent.reject(
        request.params.id,
        decision.actor,
        decision.reason,
        decision.strategy,
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
      // Prevent path traversal: artifact.path must be within the artifacts directory
      const artifactsDir = resolve(deps.paths.artifacts);
      const resolvedPath = resolve(artifact.path);
      if (!resolvedPath.startsWith(artifactsDir + sep) && resolvedPath !== artifactsDir) {
        return reply.code(403).send({ error: "path_not_allowed" });
      }
      if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
        return reply.code(404).send({ error: "artifact_content_missing" });
      }
      return reply
        .type(artifact.mimeType ?? "application/octet-stream")
        .send(createReadStream(resolvedPath));
    },
  );

  // ── Upload ──────────────────────────────────────────────────────────

  const ALLOWED_MIME_TYPES = new Set([
    // Images
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    // Video
    "video/mp4",
    "video/webm",
    // Documents
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // Text & Data
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    // Archives
    "application/zip",
    "application/x-tar",
    "application/gzip",
  ]);

  app.post("/v1/upload/presign", async (request, reply) => {
    const ossClient = deps.oss;
    if (!ossClient) {
      const err = ossNotConfigured();
      return reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
      });
    }

    try {
      const body = uploadPresignBodySchema.parse(request.body ?? {});

      // Validate MIME type against allowlist
      if (!ALLOWED_MIME_TYPES.has(body.contentType)) {
        return reply.code(400).send({
          error: "unsupported_media_type",
          message: `File type "${body.contentType}" is not supported.`,
        });
      }

      const key = ossClient.createObjectKey(body.fileName);
      const presignedUrl = await ossClient.createPresignedUrl({
        key,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
      });
      const publicUrl = ossClient.publicUrl(key);
      return { presignedUrl, publicUrl, key };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: "bad_request",
          message: formatZodIssues(error),
        });
      }
      if (error instanceof RuntimeError) {
        return reply.code(error.statusCode).send({
          error: error.code,
          message: error.statusCode >= 500
            ? "An internal server error occurred."
            : error.message,
        });
      }
      throw error;
    }
  });

  // ── Audit ──────────────────────────────────────────────────────────
  app.get("/v1/audit-logs", async (request) => {
    const query = listAuditLogsQuerySchema.parse(request.query);
    const items = await database.audit.list(query.runId);
    return query.limit ? items.slice(0, query.limit) : items;
  });
}
