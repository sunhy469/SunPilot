import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { memoryCreateBodySchema, memoryUpdateBodySchema, memorySearchQuerySchema } from "../schemas.js";
import type { SunPilotApiDeps } from "../../composition/api-deps.js";
import { formatZodIssues } from "./shared.js";

export function registerMemoryRoutes(app: FastifyInstance, deps: SunPilotApiDeps): void {
  const { database } = deps;

  // ── CRUD ────────────────────────────────────────────────────────────
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
        return reply.code(400).send({ error: "bad_request", message: formatZodIssues(error) });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/v1/memory/:id", async (request, reply) => {
    try {
      const body = memoryUpdateBodySchema.parse(request.body ?? {});
      const updated = await database.memory.update(request.params.id, {
        key: body.key, value: body.value, scope: body.scope, scopeId: body.scopeId,
        type: body.type, title: body.title, content: body.content, summary: body.summary,
        source: body.source, confidence: body.confidence, importance: body.importance,
        metadata: body.metadata, expiresAt: body.expiresAt,
      });
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return { item: updated };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({ error: "bad_request", message: formatZodIssues(error) });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string }; Body: { reason?: string } }>(
    "/v1/memory/:id",
    async (request) => {
      await database.memory.softDelete(request.params.id, request.body?.reason ?? "deleted via api");
      return { ok: true, id: request.params.id };
    },
  );

  app.get("/v1/memory", async (request) => {
    const query = memorySearchQuerySchema.parse(request.query);
    return {
      items: await database.memory.search({
        query: query.query, runId: query.runId, key: query.key,
        userId: query.userId, projectId: query.projectId, conversationId: query.conversationId,
        scopes: query.scope ? [query.scope] : undefined,
        types: query.type ? [query.type] : undefined,
        includeDeleted: query.includeDeleted, limit: query.limit,
      }),
    };
  });

  // ── Governance (§P2-8) ──────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/v1/memory/:id/mark-accessed", async (request) => {
    await database.memory.markAccessed(request.params.id);
    return { ok: true, id: request.params.id };
  });

  app.post<{ Params: { id: string }; Body: { supersededBy: string } }>(
    "/v1/memory/:id/supersede",
    async (request, reply) => {
      const { supersededBy } = request.body ?? {};
      if (!supersededBy) return reply.code(400).send({ error: "bad_request", message: "supersededBy is required" });
      await database.memory.supersede(request.params.id, supersededBy);
      return { ok: true, id: request.params.id, supersededBy };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/v1/memory/:id/mark-stale",
    async (request, reply) => {
      const { reason } = request.body ?? {};
      if (!reason) return reply.code(400).send({ error: "bad_request", message: "reason is required" });
      const updated = await database.memory.update(request.params.id, {
        staleReason: reason, staleSince: new Date().toISOString(),
      });
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return { ok: true, item: updated };
    },
  );
}
