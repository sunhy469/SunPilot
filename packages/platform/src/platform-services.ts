import type { DatabaseContext } from "@sunpilot/storage";
import { ConversationService } from "./conversations/conversation.service.js";

/**
 * Platform 层对外暴露的服务聚合接口。
 * daemon 装配时创建，api 层通过 api-deps 注入消费。
 */
export interface PlatformServices {
  conversations: ConversationService;
}

export interface CreatePlatformServicesInput {
  database: DatabaseContext;
}

export function createPlatformServices(
  input: CreatePlatformServicesInput,
): PlatformServices {
  return {
    conversations: new ConversationService({ database: input.database }),
  };
}
