import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AuditActor,
  skillManifestSchema,
  type InstalledSkillRecord,
  type SkillManifest,
} from "@sunpilot/protocol";

export interface SkillRegistryStore {
  skills: {
    upsert(input: InstalledSkillRecord): Promise<InstalledSkillRecord>;
    list(): Promise<InstalledSkillRecord[]>;
    findById(id: string): Promise<InstalledSkillRecord | null>;
    setEnabled(
      id: string,
      enabled: boolean,
    ): Promise<InstalledSkillRecord | null>;
  };
  audit: {
    create(input: {
      actor: string;
      action: string;
      target: string;
      risk?: string;
      payload: unknown;
    }): Promise<unknown>;
  };
}

function resolveSkillPath(
  skillRoot: string,
  relativePath: string,
  label: string,
): string {
  if (isAbsolute(relativePath)) {
    throw new Error(`Skill ${label} must be a relative path: ${relativePath}`);
  }
  const root = resolve(skillRoot);
  const resolved = resolve(root, relativePath);
  if (resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(
      `Skill ${label} must stay within the skill directory: ${relativePath}`,
    );
  }
  if (existsSync(resolved)) {
    const realRoot = realpathSync(root);
    const realResolved = realpathSync(resolved);
    if (realResolved === realRoot || !realResolved.startsWith(`${realRoot}${sep}`)) {
      throw new Error(`Skill ${label} resolves outside the skill directory: ${relativePath}`);
    }
    if (lstatSync(resolved).isSymbolicLink()) {
      throw new Error(`Skill ${label} must not be a symbolic link: ${relativePath}`);
    }
    return realResolved;
  }
  return resolved;
}

function requireSkillFile(
  skillRoot: string,
  relativePath: string,
  label: string,
): string {
  const resolved = resolveSkillPath(skillRoot, relativePath, label);
  if (!existsSync(resolved)) {
    throw new Error("Skill " + label + " file does not exist: " + relativePath);
  }
  return resolved;
}

function validateManifestPaths(
  skillRoot: string,
  manifest: SkillManifest,
): void {
  requireSkillFile(skillRoot, manifest.entry, "entry");
  requireSkillFile(skillRoot, manifest.readme, "readme");
  for (const capability of manifest.capabilities) {
    if (typeof capability.inputSchema === "string")
      requireSkillFile(
        skillRoot,
        capability.inputSchema,
        capability.name + " input schema",
      );
    if (typeof capability.outputSchema === "string")
      requireSkillFile(
        skillRoot,
        capability.outputSchema,
        capability.name + " output schema",
      );
  }
}

function hashSkillPackage(skillRoot: string): string {
  const hash = createHash("sha256");
  let fileCount = 0;
  let totalBytes = 0;

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const relative = path.slice(resolve(skillRoot).length + 1);
      // Package-manager dependency trees commonly contain symlinks (pnpm).
      // Lock first-party Skill source, manifest, schemas and lockfiles; runtime
      // built-in restrictions still apply to dependency code.
      if (entry.name === "node_modules" && entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) {
        throw new Error(`Skill package must not contain symbolic links: ${relative}`);
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      const content = readFileSync(path);
      totalBytes += content.byteLength;
      if (fileCount > 10_000 || totalBytes > 128 * 1024 * 1024) {
        throw new Error("Skill package exceeds integrity scan limits.");
      }
      hash.update(relative);
      hash.update("\0");
      hash.update(content);
      hash.update("\0");
    }
  };

  visit(resolve(skillRoot));
  return `sha256:${hash.digest("hex")}`;
}

/**
 * SkillRegistry — Skill 插件注册中心。
 *
 * 职责：
 * - 从磁盘目录扫描并加载 skill.json manifest
 * - 校验 manifest 路径安全（禁止路径穿越）
 * - 同步到 DB（upsert），作为 Skill 目录的唯一真实来源
 * - 提供 entry 文件的 ESM URL（用于动态 import）
 *
 * 安全约束：
 * - entry、readme、schema 路径必须相对于 skill 根目录
 * - 禁止绝对路径和路径穿越（resolveSkillPath 中的前缀检查）
 * - 加载失败的 skill 记录到 audit log，不影响其他 skill 加载
 */
export class SkillRegistry {
  private skills = new Map<string, InstalledSkillRecord>();
  private integrityById = new Map<string, string>();
  /** §A22: promise-based mutex to serialize reload() calls and prevent
   * concurrent readers from seeing an empty/partially-populated map. */
  private reloadPromise: Promise<InstalledSkillRecord[]> | null = null;

  constructor(
    private readonly db: SkillRegistryStore,
    private readonly directories: string[],
    private readonly bundledDirectories: string[] = [],
  ) {}

  async reload(): Promise<InstalledSkillRecord[]> {
    // §A22: serialize reloads — if a reload is already in progress, return
    // the same promise so concurrent callers all wait for the same result.
    if (this.reloadPromise) return this.reloadPromise;
    this.reloadPromise = this._reload();
    try {
      return await this.reloadPromise;
    } finally {
      this.reloadPromise = null;
    }
  }

  private async _reload(): Promise<InstalledSkillRecord[]> {
    // §A22: build the new map first, then atomically swap it in — readers
    // always see either the complete old map or the complete new one.
    const nextSkills = new Map<string, InstalledSkillRecord>();
    const nextIntegrity = new Map<string, string>();
    const roots = [...this.bundledDirectories, ...this.directories];
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
          const manifest = skillManifestSchema.parse(
            JSON.parse(readFileSync(manifestPath, "utf8")),
          ) as SkillManifest;
          const skillRoot = resolve(candidate);
          validateManifestPaths(skillRoot, manifest);
          const integrity = hashSkillPackage(skillRoot);
          const readmePath = requireSkillFile(
            skillRoot,
            manifest.readme,
            "readme",
          );
          const readmeSummary = readFileSync(readmePath, "utf8")
            .split("\n")
            .slice(0, 20)
            .join("\n");
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
            updatedAt: now,
          };
          nextSkills.set(record.id, record);
          nextIntegrity.set(record.id, integrity);
          await this.db.skills.upsert(record);
          await this.db.audit.create({
            actor: AuditActor.Daemon,
            action: "skill.load",
            target: record.id,
            payload: { path: record.path, version: record.version, integrity },
          });
        } catch (error) {
          await this.db.audit.create({
            actor: AuditActor.Daemon,
            action: "skill.load.failed",
            target: resolve(candidate),
            risk: "high",
            payload: {
              message: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    }
    // §A22: atomically swap the completed map — concurrent readers always
    // see a consistent snapshot (previous full map or new full map).
    this.skills = nextSkills;
    this.integrityById = nextIntegrity;
    return [...nextSkills.values()];
  }

  list(): InstalledSkillRecord[] {
    return [...this.skills.values()];
  }

  async get(id: string): Promise<InstalledSkillRecord | undefined> {
    return (
      this.skills.get(id) ?? (await this.db.skills.findById(id)) ?? undefined
    );
  }

  async setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<InstalledSkillRecord | undefined> {
    const updated = await this.db.skills.setEnabled(id, enabled);
    if (!updated) return undefined;
    this.skills.set(id, updated);
    await this.db.audit.create({
      actor: AuditActor.Daemon,
      action: enabled ? "skill.enable" : "skill.disable",
      target: id,
      payload: { enabled },
    });
    return updated;
  }

  entryUrl(skill: InstalledSkillRecord): string {
    return pathToFileURL(
      requireSkillFile(skill.path, skill.manifest.entry, "entry"),
    ).href;
  }

  verifyIntegrity(skill: InstalledSkillRecord): void {
    const expected = this.integrityById.get(skill.id);
    if (!expected) {
      throw new Error(`Skill integrity baseline is unavailable; reload the registry: ${skill.id}`);
    }
    const actual = hashSkillPackage(skill.path);
    if (actual !== expected) {
      throw new Error(`Skill package changed after registry load; reload before execution: ${skill.id}`);
    }
  }
}
