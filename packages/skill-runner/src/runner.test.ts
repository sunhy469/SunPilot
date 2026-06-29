import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { InstalledSkillRecord, StepRecord } from "@sunpilot/protocol";
import { getSunPilotPaths, InMemoryDatabaseContext, type SunPilotPaths } from "@sunpilot/storage";
import { SkillRunner, type SkillRunnerStore } from "./runner.js";

const FIXTURE_SOURCE = `
const schema = { parse(value) { return value; } };
export default {
  id: "test.slow",
  version: "0.1.0",
  capabilities: {
    "slow.wait": {
      input: schema, output: schema, risk: "low",
      async handler(input) {
        await new Promise((resolve) => setTimeout(resolve, input.delayMs));
        return input;
      }
    },
    "secret.read": {
      input: schema, output: schema, risk: "medium",
      async handler(input, context) { return { value: await context.secrets.get(input.name) }; }
    },
    "env.direct": {
      input: schema, output: schema, risk: "high",
      async handler(input) { return { value: process.env[input.name] ?? null }; }
    },
    "memory.write": {
      input: schema, output: schema, risk: "low",
      async handler(input, context) { await context.memory.write(input.key, input.value); return input; }
    },
    "event.emit": {
      input: schema, output: schema, risk: "low",
      async handler(input, context) { context.events.emit(input.type, input.payload); return input; }
    },
    "direct.fs": {
      input: schema, output: schema, risk: "high",
      async handler(input) { const fs = await import("node:fs"); return { exists: fs.existsSync(input.path) }; }
    },
    "direct.fetch": {
      input: schema, output: schema, risk: "high",
      async handler(input) { await fetch(input.url); return { ok: true }; }
    }
  }
};
`;

let home: string;
let db: InMemoryDatabaseContext;
let paths: SunPilotPaths;

let installed: InstalledSkillRecord;

function createInstalled(path: string): InstalledSkillRecord {
  return {
  id: "test.slow",
  name: "Test Slow Skill",
  version: "0.1.0",
  path,
  enabled: true,
  manifest: {
    schemaVersion: "sunpilot.skill/v1",
    id: "test.slow",
    name: "Test Slow Skill",
    version: "0.1.0",
    description: "Tests timeout and concurrency.",
    entry: "fixture.mjs",
    readme: "README.md",
    runtime: { node: ">=22", module: "esm" },
    capabilities: [
      { name: "slow.wait", title: "Wait", description: "Wait", inputSchema: {}, outputSchema: {}, risk: "low", permissions: [] },
      { name: "secret.read", title: "Read Secret", description: "Read a secret", inputSchema: {}, outputSchema: {}, risk: "medium", permissions: ["env"] },
      { name: "env.direct", title: "Direct Env", description: "Test process env isolation", inputSchema: {}, outputSchema: {}, risk: "high", permissions: [] },
      { name: "memory.write", title: "Write Memory", description: "Write memory", inputSchema: {}, outputSchema: {}, risk: "low", permissions: [] },
      { name: "event.emit", title: "Emit Event", description: "Emit event", inputSchema: {}, outputSchema: {}, risk: "low", permissions: [] },
      { name: "direct.fs", title: "Direct FS", description: "Test direct filesystem isolation", inputSchema: {}, outputSchema: {}, risk: "high", permissions: [] },
      { name: "direct.fetch", title: "Direct Fetch", description: "Test direct network isolation", inputSchema: {}, outputSchema: {}, risk: "high", permissions: [] }
    ],
    permissions: {},
    trust: "local-trusted"
  },
  installedAt: "2026-06-04T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z"
  };
}

function step(id: string, delayMs: number): StepRecord {
  return { id, runId: `run_${id}`, type: "skill", name: "Wait", status: "pending", skillId: installed.id, capability: "slow.wait", input: { delayMs } };
}

function secretStep(id: string, name: string): StepRecord {
  return { id, runId: `run_${id}`, type: "skill", name: "Read Secret", status: "pending", skillId: installed.id, capability: "secret.read", input: { name } };
}

function memoryStep(id: string, key: string, value: unknown): StepRecord {
  return { id, runId: `run_${id}`, type: "skill", name: "Write Memory", status: "pending", skillId: installed.id, capability: "memory.write", input: { key, value } };
}

function eventStep(id: string, type: string, payload: unknown): StepRecord {
  return { id, runId: `run_${id}`, type: "skill", name: "Emit Event", status: "pending", skillId: installed.id, capability: "event.emit", input: { type, payload } };
}

function runnerStore(): SkillRunnerStore {
  return {
    paths,
    getRun: async (id) => (await db.runs.findById(id)) ?? undefined,
    appendEvent: async (event) => { await db.events.append(event); },
    insertArtifact: async (artifact) => { await db.artifacts.create(artifact); },
    insertMemory: async (memory) => { await db.memory.create(memory); },
    audit: async (record) => { await db.audit.create(record); }
  };
}

function registry(record = installed) {
  return {
    get: () => record,
    entryUrl: () => pathToFileURL(join(record.path, record.manifest.entry)).href,
  } as any;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sunpilot-runner-test-"));
  writeFileSync(join(home, "fixture.mjs"), FIXTURE_SOURCE);
  installed = createInstalled(home);
  paths = getSunPilotPaths(home);
  db = new InMemoryDatabaseContext();
});

afterEach(async () => {
  await db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("SkillRunner execution controls", () => {
  test("aborts a skill after its execution timeout", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 20 });
    await expect(runner.execute(step("timeout", 200))).rejects.toThrow("timed out after 20ms");
    expect(await db.audit.list()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "skill.timeout", payload: { timeoutMs: 20, terminated: true } })]));
  });

  test("limits concurrent skill executions", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 1_000, maxConcurrency: 1 });
    const startedAt = Date.now();
    await Promise.all([runner.execute(step("one", 50)), runner.execute(step("two", 50)), runner.execute(step("three", 50))]);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
  });

  test("aborts active executions when their run is interrupted", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 2_000 });
    const execution = runner.execute(step("interrupt", 200));
    await new Promise((resolve) => setTimeout(resolve, 10));
    runner.interruptRun("run_interrupt");
    await expect(execution).rejects.toThrow("Run interrupted: run_interrupt");
  });

  test("audits allowed secret reads without exposing secret names", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-secret-value";
    const allowed = {
      ...installed,
      manifest: {
        ...installed.manifest,
        permissions: { env: { allow: ["OPENAI_API_KEY"] } }
      }
    };
    try {
      const runner = new SkillRunner(runnerStore(), registry(allowed), { timeoutMs: 2_000 });
      await expect(runner.execute(secretStep("secret", "OPENAI_API_KEY"))).resolves.toEqual({ value: "test-secret-value" });
      expect(await db.audit.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "secret.read", target: "[REDACTED_NAME]", payload: { skillId: "test.slow" } })
      ]));
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("denies secret reads not declared in manifest permissions", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 2_000 });
    await expect(runner.execute(secretStep("secret_denied", "OPENAI_API_KEY"))).rejects.toThrow("Permission denied: secret OPENAI_API_KEY is not allowed");
  });

  test("persists skill memory writes with event and audit evidence", async () => {
    await db.runs.create({
      id: "run_memory",
      title: "Memory run",
      status: "created",
      mode: "agent",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
      input: {},
      context: {}
    });
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 2_000 });
    await expect(runner.execute(memoryStep("memory", "customer.note", { text: "remember this" }))).resolves.toEqual({ key: "customer.note", value: { text: "remember this" } });

    expect(await db.memory.list({ runId: "run_memory" })).toEqual([
      expect.objectContaining({
        runId: "run_memory",
        stepId: "memory",
        key: "customer.note",
        value: { text: "remember this" },
        metadata: { skillId: "test.slow", capability: "memory.write" }
      })
    ]);
    expect(await db.events.listByRunId("run_memory")).toEqual(expect.arrayContaining([expect.objectContaining({ type: "agent.memory.written", payload: expect.objectContaining({ key: "customer.note" }) })]));
    expect(await db.audit.list("run_memory")).toEqual(expect.arrayContaining([expect.objectContaining({ action: "memory.write", target: "customer.note" })]));
  });

  test("preserves custom skill event identity inside protocol-safe progress events", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 2_000 });
    await expect(runner.execute(eventStep("event", "skill.custom", { value: 42 }))).resolves.toEqual({ type: "skill.custom", payload: { value: 42 } });

    expect(await db.events.listByRunId("run_event")).toEqual([
      expect.objectContaining({ type: "agent.tool.delta", payload: { type: "skill.custom", payload: { value: 42 } } })
    ]);
  });

  test("executes trust='isolated' skills in a child process", async () => {
    const isolated = {
      ...installed,
      manifest: { ...installed.manifest, trust: "isolated" as const },
    };
    const runner = new SkillRunner(runnerStore(), registry(isolated), { timeoutMs: 2_000 });
    await expect(runner.execute(step("iso", 10))).resolves.toEqual({ delayMs: 10 });
    expect(await db.audit.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "skill.isolation.started",
        target: "test.slow:slow.wait",
        payload: expect.objectContaining({ trust: "isolated", isolation: "child-process" }),
      }),
    ]));
  });

  test("also isolates local-trusted skills instead of importing them in the daemon", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 2_000 });
    await runner.execute(step("trust_audit", 10));
    expect(await db.audit.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: "skill.isolation.started",
        target: "test.slow:slow.wait",
        payload: expect.objectContaining({ trust: "local-trusted", isolation: "child-process" }),
      }),
    ]));
  });

  test("does not expose daemon environment variables directly to Skill code", async () => {
    const previous = process.env.SUNPILOT_TEST_SECRET;
    process.env.SUNPILOT_TEST_SECRET = "must-not-leak";
    try {
      const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 2_000 });
      const directStep = secretStep("env_direct", "SUNPILOT_TEST_SECRET");
      directStep.capability = "env.direct";
      await expect(runner.execute(directStep)).resolves.toEqual({ value: null });
    } finally {
      if (previous === undefined) delete process.env.SUNPILOT_TEST_SECRET;
      else process.env.SUNPILOT_TEST_SECRET = previous;
    }
  });

  test("blocks direct filesystem and network APIs inside the child", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 2_000 });
    const fsStep = step("direct_fs", 0);
    fsStep.capability = "direct.fs";
    fsStep.input = { path: "/etc/passwd" };
    await expect(runner.execute(fsStep)).rejects.toThrow("direct access to 'node:fs' is disabled");

    const fetchStep = step("direct_fetch", 0);
    fetchStep.capability = "direct.fetch";
    fetchStep.input = { url: "https://example.com" };
    await expect(runner.execute(fetchStep)).rejects.toThrow("direct network access is disabled");
  });
});
