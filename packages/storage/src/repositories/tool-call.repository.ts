export type ToolCallStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface ToolCallRecord {
  id: string;
  runId: string;
  stepId?: string;
  skillId: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  status: ToolCallStatus;
  riskLevel: "low" | "medium" | "high" | "critical";
  approvalId?: string;
  error?: unknown;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface CreateToolCallInput {
  id: string;
  runId: string;
  stepId?: string;
  skillId: string;
  name: string;
  arguments?: Record<string, unknown>;
  status?: ToolCallStatus;
  riskLevel?: "low" | "medium" | "high" | "critical";
  approvalId?: string;
  startedAt?: string;
  createdAt?: string;
}

export interface CompleteToolCallInput {
  result?: unknown;
  error?: unknown;
  completedAt?: string;
}

export interface ToolCallRepository {
  create(input: CreateToolCallInput): Promise<ToolCallRecord>;
  updateStatus(
    id: string,
    status: ToolCallStatus,
    input?: CompleteToolCallInput,
  ): Promise<ToolCallRecord | null>;
  findById(id: string): Promise<ToolCallRecord | null>;
  listByRunId(runId: string): Promise<ToolCallRecord[]>;
}
