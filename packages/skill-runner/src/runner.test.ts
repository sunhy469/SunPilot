import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { z } from "zod";
import type { InstalledSkillRecord, StepRecord } from "@sunpilot/protocol";
import type { SkillDefinition } from "@sunpilot/skill-sdk";
import { getSunPilotPaths, SunPilotDatabase } from "@sunpilot/storage";
import { SkillRunner } from "./runner.js";

const waitInput = z.object({ delayMs: z.number() });
const secretInput = z.object({ name: z.string() });
const secretOutput = z.object({ value: z.string().optional() });
const memoryInput = z.object({ key: z.string(), value: z.unknown() });
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
    }
  }
} satisfies SkillDefinition;

let home: string;
let db: SunPilotDatabase;

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
      { name: "memory.write", title: "Write Memory", description: "Write memory", inputSchema: {}, outputSchema: {}, risk: "low", permissions: [] }
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
  db = new SunPilotDatabase(getSunPilotPaths(home));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("SkillRunner execution controls", () => {
  test("aborts a skill after its execution timeout", async () => {
    const runner = new SkillRunner(db, registry(), { timeoutMs: 20 });
    await expect(runner.execute(step("timeout", 200))).rejects.toThrow("timed out after 20ms");
    expect(active).toBe(0);
    expect(db.listAuditLogs()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "skill.timeout", payload: { timeoutMs: 20 } })]));
  });

  test("limits concurrent skill executions", async () => {
    const runner = new SkillRunner(db, registry(), { timeoutMs: 500, maxConcurrency: 2 });
    await Promise.all([runner.execute(step("one", 30)), runner.execute(step("two", 30)), runner.execute(step("three", 30))]);
    expect(peak).toBe(2);
  });

  test("aborts active executions when their run is interrupted", async () => {
    const runner = new SkillRunner(db, registry(), { timeoutMs: 500 });
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
      const runner = new SkillRunner(db, registry(allowed), { timeoutMs: 500 });
      await expect(runner.execute(secretStep("secret", "OPENAI_API_KEY"))).resolves.toEqual({ value: "test-secret-value" });
      expect(db.listAuditLogs()).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: "secret.read", target: "[REDACTED_NAME]", payload: { skillId: "test.slow" } })
      ]));
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  test("denies secret reads not declared in manifest permissions", async () => {
    const runner = new SkillRunner(db, registry(), { timeoutMs: 500 });
    await expect(runner.execute(secretStep("secret_denied", "OPENAI_API_KEY"))).rejects.toThrow("Permission denied: secret OPENAI_API_KEY is not allowed");
  });

  test("persists skill memory writes with event and audit evidence", async () => {
    db.insertRun({
      id: "run_memory",
      title: "Memory run",
      status: "running",
      mode: "auto",
      createdAt: "2026-06-04T00:00:00.000Z",
      updatedAt: "2026-06-04T00:00:00.000Z",
      input: {},
      context: {}
    });
    const runner = new SkillRunner(db, registry(), { timeoutMs: 500 });
    await expect(runner.execute(memoryStep("memory", "customer.note", { text: "remember this" }))).resolves.toEqual({ key: "customer.note", value: { text: "remember this" } });

    expect(db.listMemory({ runId: "run_memory" })).toEqual([
      expect.objectContaining({
        runId: "run_memory",
        stepId: "memory",
        key: "customer.note",
        value: { text: "remember this" },
        metadata: { skillId: "test.slow", capability: "memory.write" }
      })
    ]);
    expect(db.listEvents("run_memory")).toEqual(expect.arrayContaining([expect.objectContaining({ type: "memory.written", payload: expect.objectContaining({ key: "customer.note" }) })]));
    expect(db.listAuditLogs("run_memory")).toEqual(expect.arrayContaining([expect.objectContaining({ action: "memory.write", target: "customer.note" })]));
  });
});
