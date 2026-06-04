import type { ZodSchema } from "zod";
import type { ArtifactRecord, SkillRisk } from "@sunpilot/protocol";

export interface SkillEventApi {
  emit(type: string, payload: unknown): void;
}

export interface SkillArtifactApi {
  write(input: { name: string; type: ArtifactRecord["type"]; content: string | Buffer; mimeType?: string; metadata?: Record<string, unknown> }): Promise<ArtifactRecord>;
}

export interface SkillFileApi {
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
}

export interface SkillMemoryApi {
  write(key: string, value: unknown): Promise<void>;
}

export interface SkillSecretApi {
  get(name: string): Promise<string | undefined>;
}

export interface SkillLogger {
  info(message: string, payload?: unknown): void;
  warn(message: string, payload?: unknown): void;
  error(message: string, payload?: unknown): void;
}

export interface SkillContext {
  runId: string;
  stepId: string;
  skillId: string;
  capability: string;
  signal: AbortSignal;
  events: SkillEventApi;
  artifacts: SkillArtifactApi;
  files: SkillFileApi;
  memory: SkillMemoryApi;
  secrets: SkillSecretApi;
  logger: SkillLogger;
}

export interface SkillCapability<I, O> {
  input: ZodSchema<I>;
  output: ZodSchema<O>;
  risk: SkillRisk;
  handler(input: I, context: SkillContext): Promise<O>;
}

export interface SkillDefinition {
  id: string;
  version: string;
  capabilities: Record<string, SkillCapability<any, any>>;
}

export function defineSkill(definition: SkillDefinition): SkillDefinition {
  return definition;
}
