import type { Permission, RiskLevel } from "../loop-types.js";

/** Re-export the validated executable call shape. */
export type { PlannedToolCall } from "../loop-types.js";

/**
 * Skill manifest summary used by candidate retrieval and Action validation.
 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  category:
    | "filesystem"
    | "shell"
    | "code"
    | "web"
    | "memory"
    | "artifact"
    | "automation"
    | "custom";
  enabled: boolean;
  /** Skill package trust; isolated third-party output remains untrusted data. */
  trust?: "local-trusted" | "isolated";
  permissions: Permission[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  supportsAbort: boolean;
  idempotent: boolean;
  /** Capability input schema (JSON Schema or simple field definitions). */
  inputSchema?: Record<string, unknown>;
  /** Capability output schema for result projection (§P2-9). */
  outputSchema?: Record<string, unknown>;
  /** Side-effect classification (§P3-10). */
  sideEffects?: "none" | "readonly" | "mutation" | "network" | "destructive";
  /** Usage examples for tool selection (§P3-10). */
  examples?: string[];
  /** MCP-compatible annotations (tags, deprecation, etc.). */
  annotations?: {
    tags?: string[];
    deprecated?: boolean;
    experimental?: boolean;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  /** Timeout and retry policy for execution control (§P3-10). */
  timeoutPolicy?: {
    defaultMs: number;
    maxMs: number;
    retryable: boolean;
    maxRetries: number;
    backoffMs: number;
  };
  riskHints: {
    defaultRisk: RiskLevel;
    destructiveArgs?: string[];
    externalHosts?: string[];
  };
  /** Response projection hints (§P2-9) — fields to extract from structured results. */
  projectionHints?: {
    /** Fields suitable for summary display (e.g. title, price, thumbnail). */
    summaryFields?: string[];
    /** Fields that identify a candidate/entity (e.g. productId, url). */
    identityFields?: string[];
    /** Fields containing source URLs for provenance. */
    sourceUrlFields?: string[];
    /** Fields expressing confidence/quality. */
    confidenceFields?: string[];
  };
}

/** Normalized tool result after execution. */
export interface NormalizedToolResult {
  toolCallId: string;
  status: "completed" | "failed" | "cancelled" | "timeout";
  summary: string;
  content?: string;
  artifacts: Array<{ id: string; name: string; type: string }>;
  structured?: Record<string, unknown>;
  stdout?: string;
  stderr?: string;
  error?: {
    code: string;
    message: string;
  };
  tokenEstimate: number;
  redacted: boolean;
}
