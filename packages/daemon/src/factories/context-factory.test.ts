import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import type { InstalledSkillRecord } from "@sunpilot/protocol";
import {
  InMemoryAgentEventBus,
  LlmEmbeddingService,
  RepositoryTraceManager,
  TraceManager,
  type LlmProvider,
} from "@sunpilot/core";

import { createContextLayer } from "./context-factory.js";

const fakeLlm: LlmProvider = {
  id: "fake",
  model: "fake-model",
  async *streamChat() {
    yield { delta: "summary", raw: {} };
  },
};

const installedSkill: InstalledSkillRecord = {
  id: "test.files",
  name: "Test Files",
  version: "0.1.0",
  path: ".",
  enabled: true,
  manifest: {
    schemaVersion: "sunpilot.skill/v1",
    id: "test.files",
    name: "Test Files",
    version: "0.1.0",
    description: "Test file skill",
    entry: "index.ts",
    readme: "README.md",
    runtime: { node: ">=22", module: "esm" },
    permissions: {},
    capabilities: [
      {
        name: "filesystem.read",
        title: "Read File",
        description: "Read a file",
        inputSchema: {},
        outputSchema: {},
        risk: "low",
        permissions: [],
      },
    ],
    trust: "local-trusted",
  },
  installedAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
};

describe("createContextLayer", () => {
  function setup() {
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();
    const embeddingService = new LlmEmbeddingService({ dimension: 1536 });
    const skillRegistry = { list: () => [installedSkill] } as any;

    return createContextLayer({
      database: db,
      rawEventBus,
      embeddingService,
      summaryLlm: fakeLlm,
      skillRegistry,
      systemPrompt: "test persona",
    });
  }

  test("returns contextBuilder, memoryWriter and traceManager", () => {
    const result = setup();

    expect(result.contextBuilder).toBeDefined();
    expect(result.rawMemoryWriter).toBeDefined();
    expect(result.memoryWriter).toBeDefined();
    expect(result.traceManager).toBeDefined();
  });

  test("summary LLM is wired lazily into ContextBuilder", async () => {
    let invoked = false;
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();
    const embeddingService = new LlmEmbeddingService({ dimension: 1536 });
    const trackingLlm: LlmProvider = {
      id: "fake",
      model: "fake-model",
      async *streamChat() {
        invoked = true;
        yield { delta: "compressed summary", raw: {} };
      },
    };

    const { contextBuilder } = createContextLayer({
      database: db,
      rawEventBus,
      embeddingService,
      summaryLlm: trackingLlm,
      skillRegistry: { list: () => [] } as any,
    });

    // Memory compression is triggered only when the context budget requires
    // it; constructing the context layer must not make a semantic model call.
    expect(contextBuilder).toBeDefined();
    expect(invoked).toBe(false); // No call yet — wiring is lazy
  });

  test("default systemPrompt is used when none is supplied", () => {
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();
    const embeddingService = new LlmEmbeddingService({ dimension: 1536 });

    const result = createContextLayer({
      database: db,
      rawEventBus,
      embeddingService,
      summaryLlm: fakeLlm,
      skillRegistry: { list: () => [] } as any,
      // systemPrompt omitted on purpose
    });

    expect(result.contextBuilder).toBeDefined();
  });

  test("traceManager falls back to in-memory TraceManager when DB has no agentTraces repo", () => {
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();
    const embeddingService = new LlmEmbeddingService({ dimension: 1536 });

    const { traceManager } = createContextLayer({
      database: db,
      rawEventBus,
      embeddingService,
      summaryLlm: fakeLlm,
      skillRegistry: { list: () => [] } as any,
    });

    // InMemoryDatabaseContext doesn't expose agentTraces, so the factory
    // must fall back to the in-memory TraceManager.
    expect(traceManager).toBeInstanceOf(TraceManager);
    expect(traceManager).not.toBeInstanceOf(RepositoryTraceManager);
  });

  test("traceManager wraps the DB-backed RepositoryTraceManager when agentTraces repo is available", () => {
    const db = new InMemoryDatabaseContext();
    // Inject a stub agentTraces repo to force the DB-backed branch.
    const dbWithTraces = Object.assign(db, {
      agentTraces: {
        create: async () => {},
        listByRunId: async () => [],
      },
    });
    const rawEventBus = new InMemoryAgentEventBus();
    const embeddingService = new LlmEmbeddingService({ dimension: 1536 });

    const { traceManager } = createContextLayer({
      database: dbWithTraces as any,
      rawEventBus,
      embeddingService,
      summaryLlm: fakeLlm,
      skillRegistry: { list: () => [] } as any,
    });

    expect(traceManager).toBeInstanceOf(RepositoryTraceManager);
  });

  test("memoryWriter wraps rawMemoryWriter (retry layer)", () => {
    const { rawMemoryWriter, memoryWriter } = setup();

    expect(rawMemoryWriter).toBeDefined();
    expect(memoryWriter).toBeDefined();
    // Retry wrapper is a distinct object from the raw writer.
    expect(memoryWriter).not.toBe(rawMemoryWriter);
  });

});
