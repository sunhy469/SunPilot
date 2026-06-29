import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { parseEnv, type LlmProvider } from "@sunpilot/core";

import { createModelLayer } from "./model-factory.js";

const fakeLlmProvider: LlmProvider = {
  id: "fake-provider",
  model: "fake-model",
  async *streamChat() {
    yield { delta: "fake", raw: {} };
  },
};

describe("createModelLayer", () => {
  test("returns embeddingService, skillEmbeddingCache, modelRouter, saveMessage, and 6 purpose LLMs", () => {
    const db = new InMemoryDatabaseContext();
    const env = parseEnv(process.env);

    const result = createModelLayer({
      database: db,
      env,
      llmProvider: fakeLlmProvider,
    });

    expect(result.embeddingService).toBeDefined();
    expect(result.skillEmbeddingCache).toBeDefined();
    expect(result.modelRouter).toBeDefined();
    expect(result.saveMessage).toBeTypeOf("function");
    expect(result.intentLlm).toBeDefined();
    expect(result.toolArgLlm).toBeDefined();
    expect(result.reflectionLlm).toBeDefined();
    expect(result.responseLlm).toBeDefined();
    expect(result.planningLlm).toBeDefined();
    expect(result.replanningLlm).toBeDefined();
  });

  test.sequential("isolates injected llmProvider from host model secrets", () => {
    const previousSeedKey = process.env.SUNPILOT_SEED_LLM_API_KEY;
    process.env.SUNPILOT_SEED_LLM_API_KEY = "must-not-be-used-by-tests";
    try {
      const db = new InMemoryDatabaseContext();
      const env = parseEnv(process.env);

      const { modelRouter } = createModelLayer({
        database: db,
        env,
        llmProvider: fakeLlmProvider,
        // enableEnvironmentProviders=false: host secrets must NOT supplement
        // the injected provider.
      });

      expect(modelRouter.getModelForPurpose("response_composition")).toBe(
        "fake-model",
      );
    } finally {
      if (previousSeedKey === undefined) {
        delete process.env.SUNPILOT_SEED_LLM_API_KEY;
      } else {
        process.env.SUNPILOT_SEED_LLM_API_KEY = previousSeedKey;
      }
    }
  });

  test("saveMessage persists with embedding (best-effort)", async () => {
    const db = new InMemoryDatabaseContext();
    const env = parseEnv(process.env);

    const { saveMessage } = createModelLayer({
      database: db,
      env,
      llmProvider: fakeLlmProvider,
    });

    await saveMessage({
      id: "msg_test",
      conversationId: "conv_test",
      role: "assistant",
      content: "hello world",
    });

    const messages = await db.messages.listByConversationId("conv_test");
    expect(messages).toEqual([
      expect.objectContaining({
        id: "msg_test",
        role: "assistant",
        content: "hello world",
      }),
    ]);
  });

  test("falls back to keyword/hash embedding when enableEnvironmentProviders is false", () => {
    const db = new InMemoryDatabaseContext();
    const env = parseEnv(process.env);

    const { embeddingService } = createModelLayer({
      database: db,
      env,
      llmProvider: fakeLlmProvider,
      enableEnvironmentProviders: false,
    });

    // Without API key + disabled env providers, embedding must fall back.
    expect(embeddingService.hasRealProvider).toBe(false);
  });

  test("purpose providers delegate to ModelRouter for streaming", async () => {
    const db = new InMemoryDatabaseContext();
    const env = parseEnv(process.env);

    const { responseLlm } = createModelLayer({
      database: db,
      env,
      llmProvider: fakeLlmProvider,
    });

    const chunks: string[] = [];
    for await (const chunk of responseLlm.streamChat({
      messages: [{ role: "user", content: "hi" }],
    })) {
      chunks.push(chunk.delta);
    }
    expect(chunks.join("")).toBe("fake");
  });
});
