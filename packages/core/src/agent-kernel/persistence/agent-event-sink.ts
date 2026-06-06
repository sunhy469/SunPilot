import type { DatabaseContext } from "@sunpilot/storage";
import type { AgentEvent } from "../agent-event-bus.js";

export interface AgentEventSink {
  persist(event: AgentEvent): Promise<void>;
}

export class RepositoryAgentEventSink implements AgentEventSink {
  constructor(private readonly db: DatabaseContext) {}

  async persist(event: AgentEvent): Promise<void> {
    if (!event.runId) return;
    await this.db.events.append({
      id: event.id,
      runId: event.runId,
      conversationId: event.conversationId,
      sequence: event.sequence,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
    });
  }
}
