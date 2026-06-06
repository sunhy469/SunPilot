import type { DatabaseContext } from "@sunpilot/storage";
import type { AgentEvent } from "../agent-event-bus.js";
import type { AgentLoopInput } from "../loop-types.js";
import type { RunState } from "../run-state-manager.js";
import { RepositoryRunStateManager } from "./repository-run-state-manager.js";

export interface InitializedAgentRun {
  state: RunState;
  event: AgentEvent;
}

export class RepositoryAgentRunInitializer {
  constructor(private readonly db: DatabaseContext) {}

  async createRunWithCreatedEvent(
    input: AgentLoopInput,
  ): Promise<InitializedAgentRun> {
    const work = async (database: DatabaseContext) => {
      const runStateManager = new RepositoryRunStateManager(database);
      const state = await runStateManager.createRun(input);
      const event: AgentEvent = {
        id: `evt_${crypto.randomUUID()}`,
        type: "agent.run.created",
        runId: input.runId,
        conversationId: input.conversationId,
        payload: {
          runId: input.runId,
          conversationId: input.conversationId,
          mode: input.mode,
          goal: input.message,
        },
        createdAt: new Date().toISOString(),
      };
      const persisted = await database.events.append({
        id: event.id,
        runId: event.runId!,
        conversationId: event.conversationId,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      });

      return {
        state,
        event: {
          ...event,
          sequence: persisted.sequence,
        },
      };
    };

    return this.db.transaction ? this.db.transaction(work) : work(this.db);
  }
}
