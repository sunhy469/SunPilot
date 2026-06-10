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

// ── HTTP ───────────────────────────────────────────────────────────────

export type SkillHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface SkillHttpRequest {
  method: SkillHttpMethod;
  url: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  timeoutMs?: number;
  responseType?: "json" | "text" | "arrayBuffer";
}

export interface SkillHttpResponse<TBody = unknown> {
  status: number;
  headers: Record<string, string>;
  body: TBody;
}

export interface SkillHttpApi {
  request<TBody = unknown>(
    input: SkillHttpRequest,
  ): Promise<SkillHttpResponse<TBody>>;
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
  http: SkillHttpApi;
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
