import type { DatabaseContext } from "@sunpilot/storage";
import type { PlatformRequestContext } from "../context.js";
import type { CreateTaskInput } from "./digital-world.types.js";
import { BeingNotFoundError } from "./digital-being.errors.js";
import type { TaskExecutor } from "./task-executor.js";

export class TaskNotFoundError extends Error {
  public readonly code = "TASK_NOT_FOUND";
  constructor(public readonly taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class TaskService {
  constructor(private readonly deps: { database: DatabaseContext; executor: TaskExecutor }) {}

  async createTask(_context: PlatformRequestContext, beingId: string, input: CreateTaskInput) {
    const being = await this.deps.database.digitalBeings.findById(beingId);
    if (!being) {
      throw new BeingNotFoundError(beingId);
    }
    const task = await this.deps.database.worldTasks.create({
      beingId,
      type: input.type,
      title: input.title,
      input: input.input,
    });
    void this.deps.executor.executeTask(_context, task.id);
    return task;
  }

  async getTask(_context: PlatformRequestContext, id: string) {
    const task = await this.deps.database.worldTasks.findById(id);
    if (!task) {
      throw new TaskNotFoundError(id);
    }
    return task;
  }

  async listTasks(_context: PlatformRequestContext, beingId: string) {
    return this.deps.database.worldTasks.listByBeingId(beingId);
  }

  async listActions(_context: PlatformRequestContext, beingId: string) {
    return this.deps.database.worldActions.listByBeingId(beingId);
  }

  async listArtifacts(_context: PlatformRequestContext, beingId: string) {
    return this.deps.database.worldArtifacts.listByBeingId(beingId);
  }

  async listActionLogs(_context: PlatformRequestContext, beingId: string) {
    return this.deps.database.worldActionLogs.listByBeingId(beingId);
  }
}
