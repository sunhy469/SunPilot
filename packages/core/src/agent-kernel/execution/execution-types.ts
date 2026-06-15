import type { ArtifactRef, ToolCallSummary } from '../loop-types.js';

/** Re-export */
export type { NormalizedToolResult } from '../tools/tool-types.js';

export interface ExecutionInput {
  runId: string;
  toolCalls: Array<{
    id: string;
    skillId: string;
    name: string;
    arguments: Record<string, unknown>;
    riskLevel: string;
    timeoutMs: number;
  }>;
}

export interface ExecutionOutput {
  runId: string;
  toolCalls: ToolCallSummary[];
  artifacts: ArtifactRef[];
  summary: string;
}

/**
 * Tool executor function — called by the orchestrator to actually run a tool.
 * This is the bridge between the agent-kernel and the skill-runner package.
 */
export interface ToolExecutor {
  execute(input: {
    runId: string;
    toolCallId: string;
    skillId: string;
    name: string;
    arguments: Record<string, unknown>;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{
    status: 'completed' | 'failed' | 'cancelled' | 'timeout';
    summary: string;
    content?: string;
    /** Structured result data for downstream consumption and projection. */
    structured?: Record<string, unknown>;
    artifacts: ArtifactRef[];
    stdout?: string;
    stderr?: string;
    error?: { code: string; message: string };
  }>;
}

/**
 * Default concurrency limits per skill category.
 * Architecture doc §17.4.
 */
export const DEFAULT_CONCURRENCY: Record<string, number> = {
  'filesystem.read': 8,
  'artifact.write': 4,
  'network.request': 4,
  'shell.execute': 1,
  'filesystem.write': 1,
  'database.write': 1,
  'model.stream': 1,
};

/** Retry backoff strategy (ms). */
export const RETRY_BACKOFF = [0, 1000, 3000]; // immediate, 1s, 3s

/** Max retry attempts for transient failures. */
export const MAX_RETRIES = 2;

/** Max repair attempts for argument validation failures. */
export const MAX_REPAIR_ATTEMPTS = 2;

/** Transient error patterns that can be retried. */
export function isRetryable(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : String(error);
  return (
    /\btimeout\b/i.test(message) ||
    /\btransient\b/i.test(message) ||
    /\bdeadlock\b/i.test(message) ||
    /\bserialization\b/i.test(message) ||
    /\brate limit\b/i.test(message) ||
    /\bECONNREFUSED\b/i.test(message) ||
    /\bETIMEDOUT\b/i.test(message) ||
    /\bENOTFOUND\b/i.test(message)
  );
}
