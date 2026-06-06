import type { RunStatus } from "@sunpilot/protocol";

export interface RunStatusHistoryRecord {
  id: string;
  runId: string;
  previousStatus?: RunStatus | string;
  nextStatus: RunStatus | string;
  reason?: string;
  actor: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateRunStatusHistoryInput {
  id?: string;
  runId: string;
  previousStatus?: RunStatus | string;
  nextStatus: RunStatus | string;
  reason?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
}

export interface RunStatusHistoryRepository {
  append(input: CreateRunStatusHistoryInput): Promise<RunStatusHistoryRecord>;
  listByRunId(runId: string): Promise<RunStatusHistoryRecord[]>;
}
