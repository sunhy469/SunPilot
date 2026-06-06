import type { SunPilotEvent } from "@sunpilot/protocol";

export interface EventRepository {
  append(event: SunPilotEvent): Promise<SunPilotEvent>;
  listByRunId(runId: string): Promise<SunPilotEvent[]>;
  listByConversationId?(conversationId: string, afterSequence?: number): Promise<SunPilotEvent[]>;
}
