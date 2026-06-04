import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { ArtifactRecord, ArtifactType } from "@sunpilot/protocol";
import type { SunPilotPaths } from "./paths.js";

export function writeArtifact(
  paths: SunPilotPaths,
  input: {
    runId: string;
    stepId?: string;
    type: ArtifactType;
    name: string;
    content: string | Buffer;
    mimeType?: string;
    metadata?: Record<string, unknown>;
  }
): ArtifactRecord {
  const id = `artifact_${crypto.randomUUID()}`;
  const runsDir = resolve(paths.artifacts, "runs");
  const runDir = resolve(runsDir, input.runId);
  if (runDir === runsDir || !runDir.startsWith(`${runsDir}${sep}`)) {
    throw new Error(`Artifact run directory is invalid: ${input.runId}`);
  }
  mkdirSync(runDir, { recursive: true });
  const path = resolve(runDir, input.name);
  if (path === runDir || !path.startsWith(`${runDir}${sep}`)) {
    throw new Error(`Artifact path must stay within its run directory: ${input.name}`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, input.content);
  const stat = statSync(path);
  return {
    id,
    runId: input.runId,
    stepId: input.stepId,
    type: input.type,
    name: input.name,
    path,
    mimeType: input.mimeType,
    sizeBytes: stat.size,
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString()
  };
}
