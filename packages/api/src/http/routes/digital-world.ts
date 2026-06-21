import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import {
  LOCAL_CONTEXT,
  BeingNotFoundError,
  InvalidBeingStatusError,
} from "@sunpilot/platform";
import type { SunPilotApiDeps } from "../../composition/api-deps.js";
import {
  createDigitalBeingBodySchema,
  updateDigitalBeingBodySchema,
  createTaskBodySchema,
  sleepBeingBodySchema,
} from "../schemas.js";
import { formatZodIssues } from "./shared.js";

export function registerDigitalWorldRoutes(app: FastifyInstance, deps: SunPilotApiDeps): void {
  const { digitalBeing, world, task } = deps.platform;

  // ── World state ──────────────────────────────────────────────────────
  app.get("/v1/digital-world", async () => {
    return world.getWorldState(LOCAL_CONTEXT);
  });

  app.get("/v1/world-nodes", async () => {
    const result = await world.listNodes(LOCAL_CONTEXT);
    return { items: result };
  });

  // ── Digital beings CRUD ──────────────────────────────────────────────
  app.get("/v1/digital-beings", async () => {
    const result = await digitalBeing.listBeings(LOCAL_CONTEXT);
    return { items: result };
  });

  app.post("/v1/digital-beings", async (request, reply) => {
    try {
      const body = createDigitalBeingBodySchema.parse(request.body ?? {});
      const being = await digitalBeing.createBeing(LOCAL_CONTEXT, {
        name: body.name,
        description: body.description,
        homeNodeId: body.homeNodeId,
        conversationId: body.conversationId,
      });
      return { item: being };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({ error: "bad_request", message: formatZodIssues(error) });
      }
      throw error;
    }
  });

  app.get<{ Params: { id: string } }>("/v1/digital-beings/:id", async (request, reply) => {
    try {
      const result = await digitalBeing.getBeing(LOCAL_CONTEXT, request.params.id);
      return { item: result };
    } catch (error) {
      if (error instanceof BeingNotFoundError) {
        return reply.code(404).send({ error: "not_found" });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/v1/digital-beings/:id", async (request, reply) => {
    try {
      const body = updateDigitalBeingBodySchema.parse(request.body ?? {});
      const being = await digitalBeing.updateBeing(LOCAL_CONTEXT, request.params.id, body);
      return { item: being };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({ error: "bad_request", message: formatZodIssues(error) });
      }
      if (error instanceof BeingNotFoundError) {
        return reply.code(404).send({ error: "not_found" });
      }
      throw error;
    }
  });

  // ── Being actions ────────────────────────────────────────────────────
  app.post<{ Params: { id: string } }>("/v1/digital-beings/:id/sleep", async (request, reply) => {
    try {
      const body = sleepBeingBodySchema.parse(request.body ?? {});
      const being = await digitalBeing.sleepBeing(LOCAL_CONTEXT, request.params.id, body.reason);
      return { item: being };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({ error: "bad_request", message: formatZodIssues(error) });
      }
      if (error instanceof BeingNotFoundError) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (error instanceof InvalidBeingStatusError) {
        return reply.code(409).send({ error: "invalid_status", message: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { id: string } }>("/v1/digital-beings/:id/wake", async (request, reply) => {
    try {
      const being = await digitalBeing.wakeBeing(LOCAL_CONTEXT, request.params.id);
      return { item: being };
    } catch (error) {
      if (error instanceof BeingNotFoundError) {
        return reply.code(404).send({ error: "not_found" });
      }
      if (error instanceof InvalidBeingStatusError) {
        return reply.code(409).send({ error: "invalid_status", message: error.message });
      }
      throw error;
    }
  });

  // ── Tasks ────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/v1/digital-beings/:id/tasks", async (request) => {
    const tasks = await task.listTasks(LOCAL_CONTEXT, request.params.id);
    return { items: tasks };
  });

  app.post<{ Params: { id: string } }>("/v1/digital-beings/:id/tasks", async (request, reply) => {
    try {
      const body = createTaskBodySchema.parse(request.body ?? {});
      const taskRecord = await task.createTask(LOCAL_CONTEXT, request.params.id, {
        type: body.type,
        title: body.title,
        input: body.input,
      });
      return { item: taskRecord };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({ error: "bad_request", message: formatZodIssues(error) });
      }
      if (error instanceof BeingNotFoundError) {
        return reply.code(404).send({ error: "not_found" });
      }
      throw error;
    }
  });

  // ── Actions & Artifacts ──────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/v1/digital-beings/:id/actions", async (request) => {
    const result = await task.listActions(LOCAL_CONTEXT, request.params.id);
    return { items: result };
  });

  app.get<{ Params: { id: string } }>("/v1/digital-beings/:id/action-logs", async (request) => {
    const logs = await task.listActionLogs(LOCAL_CONTEXT, request.params.id);
    return { items: logs };
  });

  app.get<{ Params: { id: string } }>("/v1/digital-beings/:id/artifacts", async (request) => {
    const result = await task.listArtifacts(LOCAL_CONTEXT, request.params.id);
    return { items: result };
  });

  // ── World actions ───────────────────────────────────────────────────
  app.get("/v1/world-actions", async (request) => {
    const query = request.query as { beingId?: string };
    if (query.beingId) {
      const result = await task.listActions(LOCAL_CONTEXT, query.beingId);
      return { items: result };
    }
    return { items: [] };
  });
}
