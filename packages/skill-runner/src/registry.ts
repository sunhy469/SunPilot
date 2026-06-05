import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { skillManifestSchema, type InstalledSkillRecord, type SkillManifest } from "@sunpilot/protocol";

export interface SkillRegistryStore {
  skills: {
    upsert(input: InstalledSkillRecord): Promise<InstalledSkillRecord>;
    list(): Promise<InstalledSkillRecord[]>;
    findById(id: string): Promise<InstalledSkillRecord | null>;
    setEnabled(id: string, enabled: boolean): Promise<InstalledSkillRecord | null>;
  };
  audit: {
    create(input: { actor: string; action: string; target: string; risk?: string; payload: unknown }): Promise<unknown>;
  };
}

function resolveSkillPath(skillRoot: string, relativePath: string, label: string): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Skill ${label} must be a relative path: ${relativePath}`);
  }
  const root = resolve(skillRoot);
  const resolved = resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`Skill ${label} must stay within the skill directory: ${relativePath}`);
  }
  return resolved;
}

function requireSkillFile(skillRoot: string, relativePath: string, label: string): string {
  const resolved = resolveSkillPath(skillRoot, relativePath, label);
  if (!existsSync(resolved)) {
    throw new Error("Skill " + label + " file does not exist: " + relativePath);
  }
  return resolved;
}

function validateManifestPaths(skillRoot: string, manifest: SkillManifest): void {
  resolveSkillPath(skillRoot, manifest.entry, "entry");
  requireSkillFile(skillRoot, manifest.readme, "readme");
  for (const capability of manifest.capabilities) {
    if (typeof capability.inputSchema === "string") requireSkillFile(skillRoot, capability.inputSchema, capability.name + " input schema");
    if (typeof capability.outputSchema === "string") requireSkillFile(skillRoot, capability.outputSchema, capability.name + " output schema");
  }
}

export class SkillRegistry {
  private readonly skills = new Map<string, InstalledSkillRecord>();

  constructor(
    private readonly db: SkillRegistryStore,
    private readonly directories: string[],
    private readonly fixtureDirectories: string[] = []
  ) {}

  async reload(): Promise<InstalledSkillRecord[]> {
    this.skills.clear();
    const roots = [...this.fixtureDirectories, ...this.directories];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const candidates = existsSync(join(root, "skill.json"))
        ? [root]
        : readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => join(root, entry.name));
      for (const candidate of candidates) {
        const manifestPath = join(candidate, "skill.json");
        if (!existsSync(manifestPath)) continue;
        try {
          const manifest = skillManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8"))) as SkillManifest;
          const skillRoot = resolve(candidate);
          validateManifestPaths(skillRoot, manifest);
          const readmePath = requireSkillFile(skillRoot, manifest.readme, "readme");
          const readmeSummary = readFileSync(readmePath, "utf8").split("\n").slice(0, 20).join("\n");
          const now = new Date().toISOString();
          const existing = await this.db.skills.findById(manifest.id);
          const record: InstalledSkillRecord = {
            id: manifest.id,
            name: manifest.name,
            version: manifest.version,
            path: skillRoot,
            enabled: existing?.enabled ?? true,
            manifest,
            readmeSummary,
            installedAt: existing?.installedAt ?? now,
            updatedAt: now
          };
          this.skills.set(record.id, record);
          await this.db.skills.upsert(record);
          await this.db.audit.create({ actor: "daemon", action: "skill.load", target: record.id, payload: { path: record.path, version: record.version } });
        } catch (error) {
          await this.db.audit.create({
            actor: "daemon",
            action: "skill.load.failed",
            target: resolve(candidate),
            risk: "high",
            payload: { message: error instanceof Error ? error.message : String(error) }
          });
        }
      }
    }
    return this.list();
  }

  list(): InstalledSkillRecord[] {
    return [...this.skills.values()];
  }

  async get(id: string): Promise<InstalledSkillRecord | undefined> {
    return this.skills.get(id) ?? (await this.db.skills.findById(id)) ?? undefined;
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledSkillRecord | undefined> {
    const updated = await this.db.skills.setEnabled(id, enabled);
    if (!updated) return undefined;
    this.skills.set(id, updated);
    await this.db.audit.create({ actor: "daemon", action: enabled ? "skill.enable" : "skill.disable", target: id, payload: { enabled } });
    return updated;
  }

  entryUrl(skill: InstalledSkillRecord): string {
    return pathToFileURL(resolveSkillPath(skill.path, skill.manifest.entry, "entry")).href;
  }
}
