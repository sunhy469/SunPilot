import type { ApprovalRecord, ArtifactRecord, MemoryRecord, MemorySearchInput, RunRecord, StepRecord, SunPilotEvent } from "@sunpilot/protocol";

export interface RuntimeAuditInput {
  runId?: string;
  stepId?: string;
  actor: string;
  action: string;
  target: string;
  risk?: string;
  payload: unknown;
}

export interface RuntimeStore {
  insertRun(run: RunRecord): Promise<void> | void;
  getRun(id: string): Promise<RunRecord | undefined> | RunRecord | undefined;
  listRuns(): Promise<RunRecord[]> | RunRecord[];
  updateRunStatus(id: string, status: RunRecord["status"], completedAt?: string): Promise<void> | void;
  updateRunContext(id: string, context: Record<string, unknown>): Promise<void> | void;

  insertStep(step: StepRecord): Promise<void> | void;
  listSteps(runId: string): Promise<StepRecord[]> | StepRecord[];
  updateStep(stepId: string, status: StepRecord["status"], output?: unknown, error?: unknown): Promise<void> | void;

  insertApproval(approval: ApprovalRecord): Promise<void> | void;
  decideApproval(id: string, status: "approved" | "rejected", decision: unknown): Promise<ApprovalRecord | undefined> | ApprovalRecord | undefined;
  getApproval(id: string): Promise<ApprovalRecord | undefined> | ApprovalRecord | undefined;
  listApprovals(): Promise<ApprovalRecord[]> | ApprovalRecord[];

  insertJob(job: { id: string; runId: string; status: string; attempts?: number; timeoutAt?: string; payload: unknown }): Promise<void> | void;
  updateJobStatus(runId: string, status: string, incrementAttempts?: boolean): Promise<void> | void;
  expireTimedOutJobs(now?: string): Promise<string[]> | string[];
  listJobs(runId?: string): Promise<Array<{ id: string; runId: string; status: string; attempts: number; timeoutAt?: string; payload: unknown; createdAt: string; updatedAt: string }>> | Array<{ id: string; runId: string; status: string; attempts: number; timeoutAt?: string; payload: unknown; createdAt: string; updatedAt: string }>;

  getArtifact(id: string): Promise<ArtifactRecord | undefined> | ArtifactRecord | undefined;
  listArtifacts(runId?: string): Promise<ArtifactRecord[]> | ArtifactRecord[];
  listMemory(filter?: MemorySearchInput): Promise<MemoryRecord[]> | MemoryRecord[];
  listEvents(runId: string): Promise<SunPilotEvent[]> | SunPilotEvent[];
  appendEvent(event: SunPilotEvent): Promise<void> | void;
  audit(record: RuntimeAuditInput): Promise<void> | void;
}
