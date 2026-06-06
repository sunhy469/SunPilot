export type ModelCallStatus = "pending" | "completed" | "failed" | "cancelled";

export interface ModelCallRecord {
  id: string;
  runId?: string;
  provider: string;
  model: string;
  purpose: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  costEstimate?: number;
  status: ModelCallStatus;
  error?: unknown;
  createdAt: string;
}

export interface CreateModelCallInput {
  id?: string;
  runId?: string;
  provider: string;
  model: string;
  purpose: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  costEstimate?: number;
  status?: ModelCallStatus;
  error?: unknown;
  createdAt?: string;
}

export interface CompleteModelCallInput {
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  costEstimate?: number;
  error?: unknown;
}

export interface ModelCallRepository {
  create(input: CreateModelCallInput): Promise<ModelCallRecord>;
  updateStatus(
    id: string,
    status: ModelCallStatus,
    input?: CompleteModelCallInput,
  ): Promise<ModelCallRecord | null>;
  findById(id: string): Promise<ModelCallRecord | null>;
  listByRunId(runId: string): Promise<ModelCallRecord[]>;
}
