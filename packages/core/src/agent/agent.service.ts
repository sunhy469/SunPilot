import { AgentServiceImplementation } from "./agent-service/agent-service-implementation.js";

export type {
  AgentLoopServiceConfig,
  AgentStreamDelta,
} from "./agent-service/agent-service-implementation.js";

/** Stable application-service facade. */
export class AgentService extends AgentServiceImplementation {}
