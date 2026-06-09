import type { DatabaseContext } from "@sunpilot/storage";
import type { AgentEvent } from "../agent-event-bus.js";

export interface AgentEventSink {
  /**
   * Persist an event to the database. Returns the persisted event with
   * the DB-assigned sequence, or undefined if the event was not persisted.
   *
   * If the event already has a sequence (previously persisted), it is
   * returned as-is to avoid duplicate persistence.
   */
  persist(event: AgentEvent): Promise<AgentEvent | undefined>;
}

export class RepositoryAgentEventSink implements AgentEventSink {
  constructor(private readonly db: DatabaseContext) {}

  async persist(event: AgentEvent): Promise<AgentEvent | undefined> {
    if (!event.runId) return undefined;
    // Skip if already persisted (has a valid DB sequence)
    if (event.sequence !== undefined) return event;
    const persisted = await this.db.events.append({
      id: event.id,
      runId: event.runId,
      conversationId: event.conversationId,
      sequence: event.sequence,
      type: event.type,
      payload: event.payload,
      createdAt: event.createdAt,
    });
    return {
      id: persisted.id,
      type: persisted.type,
      runId: persisted.runId,
      conversationId: persisted.conversationId,
      sequence: persisted.sequence,
      payload: persisted.payload as Record<string, unknown>,
      createdAt: persisted.createdAt,
    };
  }
}
