import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { InstalledSkillRecord, StepRecord } from "@sunpilot/protocol";
import type { SkillDefinition } from "@sunpilot/skill-sdk";
import { getSunPilotPaths, InMemoryDatabaseContext, type SunPilotPaths } from "@sunpilot/storage";
import { SkillRunner, type SkillRunnerStore } from "./runner.js";

const waitInput = z.object({ delayMs: z.number() });
const secretInput = z.object({ name: z.string() });
const secretOutput = z.object({ value: z.string().optional() });
const memoryInput = z.object({ key: z.string(), value: z.unknown() });
const eventInput = z.object({ type: z.string(), payload: z.unknown() });
let active = 0;
let peak = 0;

export default {
  id: "test.slow",
  version: "0.1.0",
  capabilities: {
    "slow.wait": {
      input: waitInput,
      output: waitInput,
      risk: "low",
      async handler(input: unknown, context) {
        active += 1;
        peak = Math.max(peak, active);
        try {
          const delayMs = (input as { delayMs: number }).delayMs;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, delayMs);
            context.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(context.signal.reason);
            });
          });
          return input;
        } finally {
          active -= 1;
        }
      }
    },
    "secret.read": {
      input: secretInput,
      output: secretOutput,
      risk: "medium",
      async handler(input, context) {
        return { value: await context.secrets.get(input.name) };
      }
    },
    "memory.write": {
      input: memoryInput,
      output: memoryInput,
      risk: "low",
      async handler(input, context) {
        await context.memory.write(input.key, input.value);
        return input;
      }
    },
    "event.emit": {
      input: eventInput,
      output: eventInput,
      risk: "low",
      async handler(input, context) {
        context.events.emit(input.type, input.payload);
        return input;
      }
    }
  }
} satisfies SkillDefinition;

let home: string;
let db: InMemoryDatabaseContext;
let paths: SunPilotPaths;

const installed: InstalledSkillRecord = {
  id: "test.slow",
  name: "Test Slow Skill",
  version: "0.1.0",
  path: ".",
  enabled: true,
  manifest: {
    schemaVersion: "sunpilot.skill/v1",
    id: "test.slow",
    name: "Test Slow Skill",
    version: "0.1.0",
    description: "Tests timeout and concurrency.",
    entry: "runner.test.ts",
    readme: "README.md",
    runtime: { node: ">=22", module: "esm" },
    capabilities: [
      { name: "slow.wait", title: "Wait", description: "Wait", inputSchema: {}, outputSchema: {}, risk: "low", permissions: [] },
      { name: "secret.read", title: "Read Secret", description: "Read a secret", inputSchema: {}, outputSchema: {}, risk: "medium", permissions: ["env"] },
      { name: "memory.write", title: "Write Memory", description: "Write memory", inputSchema: {}, outputSchema: {}, risk: "low", permissions: [] },
      { name: "event.emit", title: "Emit Event", description: "Emit event", inputSchema: {}, outputSchema: {}, risk: "low", permissions: [] }
    ],
    permissions: {}
  },
  installedAt: "2026-06-04T00:00:00.000Z",
  updatedAt: "2026-06-04T00:00:00.000Z"
};

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
    entryUrl: () => pathToFileURL(import.meta.filename).href
  } as any;
}

beforeEach(() => {
  active = 0;
  peak = 0;
  home = mkdtempSync(join(tmpdir(), "sunpilot-runner-test-"));
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
    expect(active).toBe(0);
    expect(await db.audit.list()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "skill.timeout", payload: { timeoutMs: 20 } })]));
  });

  test("limits concurrent skill executions", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 500, maxConcurrency: 2 });
    await Promise.all([runner.execute(step("one", 30)), runner.execute(step("two", 30)), runner.execute(step("three", 30))]);
    expect(peak).toBe(2);
  });

  test("aborts active executions when their run is interrupted", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 500 });
    const execution = runner.execute(step("interrupt", 200));
    await new Promise((resolve) => setTimeout(resolve, 10));
    runner.interruptRun("run_interrupt");
    await expect(execution).rejects.toThrow("Run interrupted: run_interrupt");
    expect(active).toBe(0);
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
      const runner = new SkillRunner(runnerStore(), registry(allowed), { timeoutMs: 500 });
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
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 500 });
    await expect(runner.execute(secretStep("secret_denied", "OPENAI_API_KEY"))).rejects.toThrow("Permission denied: secret OPENAI_API_KEY is not allowed");
  });

  test("persists skill memory writes with event and audit evidence", async () => {
    await db.runs.create({
      id: "run_memory",
      title: "Memory run",
      status: "running",
      mode: "auto",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
      input: {},
      context: {}
    });
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 500 });
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
    expect(await db.events.listByRunId("run_memory")).toEqual(expect.arrayContaining([expect.objectContaining({ type: "memory.written", payload: expect.objectContaining({ key: "customer.note" }) })]));
    expect(await db.audit.list("run_memory")).toEqual(expect.arrayContaining([expect.objectContaining({ action: "memory.write", target: "customer.note" })]));
  });

  test("preserves custom skill event identity inside protocol-safe progress events", async () => {
    const runner = new SkillRunner(runnerStore(), registry(), { timeoutMs: 500 });
    await expect(runner.execute(eventStep("event", "skill.custom", { value: 42 }))).resolves.toEqual({ type: "skill.custom", payload: { value: 42 } });

    expect(await db.events.listByRunId("run_event")).toEqual([
      expect.objectContaining({ type: "step.progress", payload: { type: "skill.custom", payload: { value: 42 } } })
    ]);
  });
});
