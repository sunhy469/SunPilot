import type { ApprovalRecord, MemorySearchInput, RunRecord, StepRecord, SunPilotEvent } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type { RuntimeAuditInput, RuntimeStore } from "./runtime.store.js";

export class RepositoryRuntimeStore implements RuntimeStore {
  private readonly eventSubscribers = new Set<(event: SunPilotEvent) => void>();

  constructor(private readonly db: DatabaseContext) {}

  async insertRun(run: RunRecord): Promise<void> {
    await this.db.runs.create(run);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return (await this.db.runs.findById(id)) ?? undefined;
  }

  async listRuns(): Promise<RunRecord[]> {
    return this.db.runs.list();
  }

  async updateRunStatus(id: string, status: RunRecord["status"], completedAt?: string): Promise<void> {
    await this.db.runs.updateStatus(id, status, completedAt);
  }

  async updateRunContext(id: string, context: Record<string, unknown>): Promise<void> {
    await this.db.runs.updateContext(id, context);
  }

  async insertStep(step: StepRecord): Promise<void> {
    await this.db.steps.create(step);
  }

  async listSteps(runId: string): Promise<StepRecord[]> {
    return this.db.steps.listByRunId(runId);
  }

  async updateStep(stepId: string, status: StepRecord["status"], output?: unknown, error?: unknown): Promise<void> {
    await this.db.steps.updateStatus(stepId, status, output, error);
  }

  async insertApproval(approval: ApprovalRecord): Promise<void> {
    await this.db.approvals.create(approval);
  }

  async decideApproval(id: string, status: "approved" | "rejected", decision: unknown): Promise<ApprovalRecord | undefined> {
    return (await this.db.approvals.decide(id, status, decision)) ?? undefined;
  }

  async getApproval(id: string): Promise<ApprovalRecord | undefined> {
    return (await this.db.approvals.findById(id)) ?? undefined;
  }

  async listApprovals(): Promise<ApprovalRecord[]> {
    return this.db.approvals.list();
  }

  async insertJob(job: { id: string; runId: string; status: string; attempts?: number; timeoutAt?: string; payload: unknown }): Promise<void> {
    await this.db.jobs.create(job);
  }

  async updateJobStatus(runId: string, status: string, incrementAttempts = false): Promise<void> {
    await this.db.jobs.updateStatus(runId, status, incrementAttempts);
  }

  async expireTimedOutJobs(now?: string): Promise<string[]> {
    return this.db.jobs.expireTimedOut(now);
  }

  async listJobs(runId?: string) {
    return this.db.jobs.list(runId);
  }

  async getArtifact(id: string) {
    return (await this.db.artifacts.findById(id)) ?? undefined;
  }

  async listArtifacts(runId?: string) {
    return this.db.artifacts.list(runId);
  }

  async insertArtifact(artifact: Awaited<ReturnType<DatabaseContext["artifacts"]["create"]>>): Promise<void> {
    await this.db.artifacts.create(artifact);
  }

  async listMemory(filter: MemorySearchInput = {}) {
    return this.db.memory.list(filter);
  }

  async insertMemory(memory: Awaited<ReturnType<DatabaseContext["memory"]["create"]>>): Promise<void> {
    await this.db.memory.create(memory);
  }

  async listEvents(runId: string) {
    return this.db.events.listByRunId(runId);
  }

  async appendEvent(event: SunPilotEvent): Promise<void> {
    await this.db.events.append(event);
    for (const subscriber of this.eventSubscribers) subscriber(event);
  }

  async audit(record: RuntimeAuditInput): Promise<void> {
    await this.db.audit.create(record);
  }

  subscribeEvents(subscriber: (event: SunPilotEvent) => void): () => void {
    this.eventSubscribers.add(subscriber);
    return () => this.eventSubscribers.delete(subscriber);
  }

  async recoverInterrupted(): Promise<void> {
    const now = new Date().toISOString();
    const interruptedRuns = (await this.listRuns()).filter((item) => ["queued", "planning", "running"].includes(item.status));
    for (const run of interruptedRuns) {
      await this.updateRunStatus(run.id, "interrupted", now);
      for (const step of await this.listSteps(run.id)) {
        if (["pending", "running", "waiting_approval"].includes(step.status)) {
          await this.updateStep(step.id, "interrupted", undefined, { reason: "daemon restarted while run was unfinished" });
        }
      }
      await this.updateJobStatus(run.id, "interrupted");
      await this.appendEvent({
        id: `evt_${crypto.randomUUID()}`,
        runId: run.id,
        type: "run.interrupted",
        payload: { reason: "daemon restarted while run was unfinished" },
        createdAt: now
      });
    }
    await this.expireTimedOutJobs(now);
  }
}
