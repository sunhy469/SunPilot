import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getSunPilotPaths, SunPilotDatabase } from "@sunpilot/storage";
import { SkillRegistry } from "./registry.js";

let home: string;
let db: SunPilotDatabase;

function writeSkill(root: string, overrides: Record<string, unknown> = {}) {
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "schemas"), { recursive: true });
  writeFileSync(join(root, "README.md"), "Test skill\n");
  writeFileSync(join(root, "dist", "index.js"), "export default {}\n");
  writeFileSync(join(root, "schemas", "input.json"), "{}\n");
  writeFileSync(join(root, "schemas", "output.json"), "{}\n");
  writeFileSync(
    join(root, "skill.json"),
    JSON.stringify(
      {
        schemaVersion: "sunpilot.skill/v1",
        id: "test.registry-skill",
        name: "Registry Skill",
        version: "0.1.0",
        description: "Registry test skill.",
        entry: "dist/index.js",
        readme: "README.md",
        runtime: { node: ">=22", module: "esm" },
        capabilities: [
          {
            name: "test.run",
            title: "Run",
            description: "Run",
            inputSchema: "schemas/input.json",
            outputSchema: "schemas/output.json",
            risk: "low",
            permissions: []
          }
        ],
        permissions: {},
        ...overrides
      },
      null,
      2
    )
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sunpilot-registry-test-"));
  db = new SunPilotDatabase(getSunPilotPaths(home));
});

afterEach(() => {
  db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("SkillRegistry manifest path hardening", () => {
  test("loads a valid skill and records audit", async () => {
    const skillRoot = join(home, "skills", "registry-skill");
    writeSkill(skillRoot);
    const registry = new SkillRegistry(db, [join(home, "skills")]);

    const skills = await registry.reload();

    expect(skills).toEqual([expect.objectContaining({ id: "test.registry-skill", path: skillRoot })]);
    expect(db.listAuditLogs()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "skill.load", target: "test.registry-skill" })]));
  });

  test("skips manifest paths that escape the skill directory", async () => {
    const skillRoot = join(home, "skills", "bad-skill");
    writeSkill(skillRoot, { entry: "../outside.js" });
    const registry = new SkillRegistry(db, [join(home, "skills")]);

    await expect(registry.reload()).resolves.toEqual([]);
    expect(db.listAuditLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "skill.load.failed",
          target: expect.stringContaining("/skills/bad-skill"),
          risk: "high",
          payload: expect.objectContaining({ message: expect.stringContaining("must stay within the skill directory") })
        })
      ])
    );
  });

  test("skips manifests that reference missing readme files", async () => {
    const skillRoot = join(home, "skills", "missing-readme-skill");
    writeSkill(skillRoot);
    unlinkSync(join(skillRoot, "README.md"));
    const registry = new SkillRegistry(db, [join(home, "skills")]);

    await expect(registry.reload()).resolves.toEqual([]);
    expect(db.listAuditLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "skill.load.failed",
          target: expect.stringContaining("/skills/missing-readme-skill"),
          risk: "high",
          payload: expect.objectContaining({ message: expect.stringContaining("Skill readme file does not exist") })
        })
      ])
    );
  });

  test("continues scanning valid skills after a malicious manifest fails", async () => {
    const badRoot = join(home, "skills", "bad-skill");
    const goodRoot = join(home, "skills", "good-skill");
    writeSkill(badRoot, { entry: "../outside.js" });
    writeSkill(goodRoot, { id: "test.good-skill" });
    const registry = new SkillRegistry(db, [join(home, "skills")]);

    await expect(registry.reload()).resolves.toEqual([expect.objectContaining({ id: "test.good-skill", path: goodRoot })]);
    expect(db.listAuditLogs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "skill.load.failed", target: expect.stringContaining("/skills/bad-skill") }),
        expect.objectContaining({ action: "skill.load", target: "test.good-skill" })
      ])
    );
  });
});
