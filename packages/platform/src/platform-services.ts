import type { DatabaseContext } from "@sunpilot/storage";
import { ConversationService } from "./conversations/conversation.service.js";
import { DigitalBeingService } from "./digital-world/digital-being.service.js";
import { WorldService } from "./digital-world/world.service.js";
import { TaskService } from "./digital-world/task.service.js";
import { TaskExecutor } from "./digital-world/task-executor.js";

/**
 * Platform 层对外暴露的服务聚合接口。
 * daemon 装配时创建，api 层通过 api-deps 注入消费。
 */
export interface PlatformServices {
  conversations: ConversationService;
  digitalBeing: DigitalBeingService;
  world: WorldService;
  task: TaskService;
  /** Get the TaskExecutor for agent run event handling. */
  executor: TaskExecutor;
}

export interface CreatePlatformServicesInput {
  database: DatabaseContext;
  /** Async factory to obtain the AgentService (lazy-initialized).
   *  Platform does not import AgentService directly to avoid circular deps. */
  getAgent?: () => Promise<{
    startChatCommand: (
      input: {
        conversationId?: string;
        message: string;
        mode?: "chat" | "agent";
      },
      ctx: { source: "web" | "cli" | "api" },
    ) => Promise<{ runId: string; conversationId: string }>;
  }>;
}

export function createPlatformServices(
  input: CreatePlatformServicesInput,
): PlatformServices {
  const executor = new TaskExecutor({ database: input.database, getAgent: input.getAgent });
  return {
    conversations: new ConversationService({ database: input.database }),
    digitalBeing: new DigitalBeingService({ database: input.database }),
    world: new WorldService({ database: input.database }),
    task: new TaskService({ database: input.database, executor }),
    executor,
  };
}
