import { describe, expect, test } from "vitest";
import type { AgentLoopInput } from "../loop-types.js";
import type { ReactCheckpoint } from "../react-loop/react-types.js";
import { InMemoryRunStateManager } from "../run-state-manager.js";
import { RunStateReactCheckpointRepository } from "./react-checkpoint-repository.js";

describe("RunStateReactCheckpointRepository", () => {
  test("round-trips the complete checkpoint through run task state", async () => {
    const states = new InMemoryRunStateManager();
    const input: AgentLoopInput = {
      runId: "run_checkpoint",
      conversationId: "conv_checkpoint",
      userMessageId: "user_checkpoint",
      message: "test",
      mode: "agent",
      client: { source: "api" },
    };
    await states.createRun(input);
    const repository = new RunStateReactCheckpointRepository(states);
    const checkpoint: ReactCheckpoint = {
      version: 1,
      runId: input.runId,
      conversationId: input.conversationId,
      messageId: "assistant_checkpoint",
      iteration: 2,
      modelCalls: 3,
      transcript: [{ role: "user", content: "test" }],
      candidateToolIds: ["test:search"],
      pendingToolCalls: [],
      artifacts: [],
      toolCallSummaries: [],
      partsSnapshot: [],
      permissionMode: "auto",
      updatedAt: new Date().toISOString(),
    };

    await repository.save(checkpoint);

    await expect(repository.findByRunId(input.runId)).resolves.toEqual(checkpoint);
  });
});
