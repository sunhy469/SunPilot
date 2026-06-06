import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import type { ArtifactRecord, ArtifactType } from "@sunpilot/protocol";
import type { SunPilotPaths } from "./paths.js";

export function writeArtifact(
  paths: SunPilotPaths,
  input: {
    runId: string;
    stepId?: string;
    conversationId?: string;
    type: ArtifactType;
    name: string;
    content: string | Buffer;
    mimeType?: string;
    version?: number;
    metadata?: Record<string, unknown>;
  },
): ArtifactRecord {
  const id = `artifact_${crypto.randomUUID()}`;
  const runsDir = resolve(paths.artifacts, "runs");
  const runDir = resolve(runsDir, input.runId);
  if (runDir === runsDir || !runDir.startsWith(`${runsDir}${sep}`)) {
    throw new Error(`Artifact run directory is invalid: ${input.runId}`);
  }
  mkdirSync(runDir, { recursive: true });
  const version =
    input.version ?? nextAvailableArtifactVersion(runDir, input.name);
  const storageName =
    version > 1 ? versionedArtifactName(input.name, version) : input.name;
  const path = resolve(runDir, storageName);
  if (path === runDir || !path.startsWith(`${runDir}${sep}`)) {
    throw new Error(
      `Artifact path must stay within its run directory: ${input.name}`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, input.content);
  const stat = statSync(path);
  const content =
    typeof input.content === "string"
      ? Buffer.from(input.content)
      : input.content;
  const storageKey = `runs/${input.runId}/${storageName}`;
  return {
    id,
    runId: input.runId,
    stepId: input.stepId,
    conversationId: input.conversationId,
    type: input.type,
    name: input.name,
    path,
    storageKey,
    checksum: createHash("sha256").update(content).digest("hex"),
    version,
    mimeType: input.mimeType,
    sizeBytes: stat.size,
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString(),
  };
}

function nextAvailableArtifactVersion(runDir: string, name: string): number {
  let version = 1;
  while (
    existsSync(
      resolve(
        runDir,
        version > 1 ? versionedArtifactName(name, version) : name,
      ),
    )
  ) {
    version += 1;
  }
  return version;
}

function versionedArtifactName(name: string, version: number): string {
  const extension = extname(name);
  const stem = extension ? basename(name, extension) : name;
  return `${stem}.v${version}${extension}`;
}
