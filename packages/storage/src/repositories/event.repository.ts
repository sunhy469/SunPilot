import type { SunPilotEvent } from "@sunpilot/protocol";

export interface EventRepository {
  append(event: SunPilotEvent): Promise<SunPilotEvent>;
  listByRunId(runId: string): Promise<SunPilotEvent[]>;
  listByConversationId?(conversationId: string, afterSequence?: number): Promise<SunPilotEvent[]>;
  /** Durable spool used before an event is delivered to the canonical log. */
  enqueueOutbox?(event: SunPilotEvent): Promise<void>;
  listOutbox?(limit?: number): Promise<SunPilotEvent[]>;
  deleteOutbox?(eventId: string): Promise<void>;
}
