import type { ApprovalRecord, RunMode, RunRecord, StepRecord, SunPilotEvent } from "@sunpilot/protocol";
import type { SunPilotDatabase } from "@sunpilot/storage";
import type { WorkflowRegistry } from "@sunpilot/workflow";
import { conflict, notFound } from "./errors.js";
import type { ToolCapability, ToolProvider } from "./providers.js";

export class SunPilotRuntime {
  constructor(
    private readonly db: SunPilotDatabase,
    private readonly workflows: WorkflowRegistry,
    private readonly providers: ToolProvider[]
  ) {}

  async listCapabilities() {
    const capabilityLists = await Promise.all(this.providers.map((provider) => provider.listCapabilities()));
    return capabilityLists.flat();
  }

  async createRun(input: unknown, workflowId = "fixture.echo", mode: RunMode = "approval_required"): Promise<RunRecord> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      throw notFound(`Unknown workflow: ${workflowId}`);
    }
    const now = new Date().toISOString();
    const plan = await workflow.plan(input, {});
    const run: RunRecord = {
      id: `run_${crypto.randomUUID()}`,
      title: plan.runTitle,
      status: "planning",
      mode,
      workflowId,
      createdAt: now,
      updatedAt: now,
      input,
      context: { plan }
    };
    this.db.insertRun(run);
    this.db.insertJob({ id: `job_${crypto.randomUUID()}`, runId: run.id, status: "pending", payload: { workflowId, mode } });
    this.emit({ runId: run.id, type: "run.created", payload: run });
    this.emit({ runId: run.id, type: "workflow.selected", payload: { workflowId } });
    this.emit({ runId: run.id, type: "workflow.planned", payload: plan });

    for (const planned of plan.steps) {
      const step: StepRecord = {
        id: `${run.id}_${planned.id}`,
        runId: run.id,
        type: planned.type,
        name: planned.name,
        status: "pending",
        workflowId,
        skillId: planned.providerId,
        capability: planned.capability,
        input: planned.input
      };
      this.db.insertStep(step);
      this.emit({ runId: run.id, stepId: step.id, type: "step.created", payload: step });
    }

    if (mode === "dry_run") {
      for (const step of this.db.listSteps(run.id)) {
        this.db.updateStep(step.id, "skipped", { dryRun: true });
      }
      this.db.updateRunStatus(run.id, "completed", new Date().toISOString());
      this.db.updateJobStatus(run.id, "completed");
      this.emit({ runId: run.id, type: "run.completed", payload: { dryRun: true } });
      return this.db.getRun(run.id)!;
    }

    await this.continueRun(run.id);
    return this.db.getRun(run.id)!;
  }

  async approve(approvalId: string, decision: unknown): Promise<ApprovalRecord> {
    this.ensureApprovalCanBeDecided(approvalId);
    const approval = this.db.decideApproval(approvalId, "approved", decision);
    if (!approval) throw this.approvalDecisionError(approvalId);
    this.db.audit({ runId: approval.runId, stepId: approval.stepId, actor: "local-user", action: "approval.approve", target: approval.id, risk: approval.risk, payload: decision });
    this.emit({ runId: approval.runId, stepId: approval.stepId, type: "approval.approved", payload: approval });
    if (approval.stepId) {
      const step = this.db.listSteps(approval.runId).find((item) => item.id === approval.stepId);
      if (step?.type === "approval") {
        this.db.updateStep(approval.stepId, "completed", { approved: true });
        this.emit({ runId: approval.runId, stepId: approval.stepId, type: "step.completed", payload: { approvalId } });
      } else if (step?.type === "skill") {
        this.db.updateStep(approval.stepId, "pending");
      }
    }
    await this.continueRun(approval.runId);
    return approval;
  }

  reject(approvalId: string, decision: unknown): ApprovalRecord {
    this.ensureApprovalCanBeDecided(approvalId);
    const approval = this.db.decideApproval(approvalId, "rejected", decision);
    if (!approval) throw this.approvalDecisionError(approvalId);
    this.db.audit({ runId: approval.runId, stepId: approval.stepId, actor: "local-user", action: "approval.reject", target: approval.id, risk: approval.risk, payload: decision });
    this.emit({ runId: approval.runId, stepId: approval.stepId, type: "approval.rejected", payload: approval });
    if (approval.stepId) this.db.updateStep(approval.stepId, "canceled", undefined, { rejected: true });
    this.db.updateRunStatus(approval.runId, "canceled", new Date().toISOString());
    this.db.updateJobStatus(approval.runId, "canceled");
    this.emit({ runId: approval.runId, type: "run.canceled", payload: { approvalId } });
    return approval;
  }

  interrupt(runId: string): RunRecord {
    const run = this.db.getRun(runId);
    if (!run) {
      throw notFound(`Unknown run: ${runId}`);
    }
    for (const provider of this.providers) provider.interrupt?.(runId);
    this.db.updateRunStatus(runId, "interrupted", new Date().toISOString());
    this.db.updateJobStatus(runId, "interrupted");
    for (const step of this.db.listSteps(runId)) {
      if (!["completed", "failed", "skipped", "canceled", "interrupted"].includes(step.status)) {
        this.db.updateStep(step.id, "interrupted", undefined, { reason: "run interrupted" });
        this.emit({ runId, stepId: step.id, type: "step.interrupted", payload: { actor: "local-user" } });
      }
    }
    this.emit({ runId, type: "run.interrupted", payload: { actor: "local-user" } });
    return this.db.getRun(runId)!;
  }

  cancel(runId: string): RunRecord {
    const run = this.db.getRun(runId);
    if (!run) {
      throw notFound(`Unknown run: ${runId}`);
    }
    for (const provider of this.providers) provider.interrupt?.(runId);
    this.db.updateRunStatus(runId, "canceled", new Date().toISOString());
    this.db.updateJobStatus(runId, "canceled");
    for (const step of this.db.listSteps(runId)) {
      if (!["completed", "failed", "skipped", "canceled", "interrupted"].includes(step.status)) {
        this.db.updateStep(step.id, "canceled", undefined, { reason: "run canceled" });
      }
    }
    this.db.audit({ runId, actor: "local-user", action: "run.cancel", target: runId, payload: { actor: "local-user" } });
    this.emit({ runId, type: "run.canceled", payload: { actor: "local-user" } });
    return this.db.getRun(runId)!;
  }

  async retry(runId: string): Promise<RunRecord> {
    const run = this.db.getRun(runId);
    if (!run) {
      throw notFound(`Unknown run: ${runId}`);
    }
    const retry = await this.createRun(run.input, run.workflowId ?? "fixture.echo", run.mode);
    retry.context.retryOf = runId;
    this.db.updateRunContext(retry.id, retry.context);
    this.db.audit({ runId, actor: "daemon", action: "run.retry", target: retry.id, payload: { sourceRunId: runId } });
    this.emit({ runId, type: "run.interrupted", payload: { retryRunId: retry.id, reason: "retry requested" } });
    return retry;
  }

  private async continueRun(runId: string): Promise<void> {
    const run = this.db.getRun(runId);
    if (!run || ["completed", "canceled", "failed", "interrupted"].includes(run.status)) return;

    this.db.updateRunStatus(runId, "running");
    this.db.updateJobStatus(runId, "running", true);
    this.emit({ runId, type: "run.started", payload: {} });

    const steps = this.db.listSteps(runId);
    for (const step of steps) {
      if (step.status === "completed") continue;
      if (step.type === "approval") {
        const approval = this.requestApproval(step);
        this.db.updateRunStatus(runId, "waiting_approval");
        this.db.updateJobStatus(runId, "waiting_approval");
        this.db.updateStep(step.id, "waiting_approval");
        return;
      }
      if (step.type === "skill") {
        const capability = await this.capabilityForStep(step);
        if (this.requiresApproval(capability) && !this.hasApprovedCapability(step)) {
          this.requestApproval(step, capability);
          this.db.updateRunStatus(runId, "waiting_approval");
          this.db.updateJobStatus(runId, "waiting_approval");
          this.db.updateStep(step.id, "waiting_approval");
          return;
        }
        await this.executeSkillStep(step);
        const current = this.db.getRun(runId);
        if (!current || ["completed", "canceled", "failed", "interrupted"].includes(current.status)) return;
      }
    }

    const current = this.db.getRun(runId);
    if (!current || ["completed", "canceled", "failed", "interrupted"].includes(current.status)) return;
    this.db.updateRunStatus(runId, "completed", new Date().toISOString());
    this.db.updateJobStatus(runId, "completed");
    this.emit({ runId, type: "run.completed", payload: { artifacts: this.db.listArtifacts(runId) } });
  }

  private requestApproval(step: StepRecord, capability?: ToolCapability): ApprovalRecord {
    const now = new Date().toISOString();
    const input = (step.input ?? {}) as { title?: string; reason?: string; requestedAction?: unknown };
    const approval: ApprovalRecord = {
      id: `approval_${crypto.randomUUID()}`,
      runId: step.runId,
      stepId: step.id,
      status: "pending",
      risk: capability?.risk === "critical" ? "critical" : capability?.risk === "medium" ? "medium" : "high",
      title: input.title ?? (capability ? `Approve ${capability.title}` : step.name),
      reason: input.reason ?? (capability ? `${capability.risk} risk capability requires approval before execution.` : "This action requires approval."),
      requestedAction: input.requestedAction ?? (capability ? { skillId: step.skillId, capability: step.capability, input: step.input } : step.input),
      createdAt: now
    };
    this.db.insertApproval(approval);
    this.db.audit({ runId: step.runId, stepId: step.id, actor: "daemon", action: "approval.request", target: approval.id, risk: approval.risk, payload: approval.requestedAction });
    this.emit({ runId: step.runId, stepId: step.id, type: "approval.requested", payload: approval });
    return approval;
  }

  private approvalDecisionError(approvalId: string): Error {
    const existing = this.db.getApproval(approvalId);
    if (!existing) return notFound(`Unknown approval: ${approvalId}`);
    return conflict(`Approval is already ${existing.status}: ${approvalId}`);
  }

  private ensureApprovalCanBeDecided(approvalId: string): ApprovalRecord {
    const approval = this.db.getApproval(approvalId);
    if (!approval) throw notFound(`Unknown approval: ${approvalId}`);
    if (approval.status !== "pending") throw conflict(`Approval is already ${approval.status}: ${approvalId}`);
    this.ensureApprovalRunCanBeDecided(approval);
    return approval;
  }

  private ensureApprovalRunCanBeDecided(approval: ApprovalRecord): void {
    const run = this.db.getRun(approval.runId);
    if (!run) throw notFound(`Unknown run: ${approval.runId}`);
    if (["completed", "canceled", "failed", "interrupted"].includes(run.status)) {
      throw conflict(`Run is already ${run.status}: ${approval.runId}`);
    }
  }

  private async capabilityForStep(step: StepRecord): Promise<ToolCapability | undefined> {
    if (!step.skillId || !step.capability) return undefined;
    const capabilities = await this.listCapabilities();
    return capabilities.find((item) => item.providerId === step.skillId && item.capabilityName === step.capability);
  }

  private requiresApproval(capability: ToolCapability | undefined): boolean {
    if (!capability) return false;
    const permissions = capability.permissions;
    return (
      capability.risk === "high" ||
      capability.risk === "critical" ||
      (permissions.filesystem?.read?.length ?? 0) > 0 ||
      (permissions.filesystem?.write?.length ?? 0) > 0 ||
      (permissions.network?.allow?.length ?? 0) > 0 ||
      (permissions.env?.allow?.length ?? 0) > 0 ||
      permissions.shell === true
    );
  }

  private hasApprovedCapability(step: StepRecord): boolean {
    return this.db.listApprovals().some((approval) => {
      if (approval.runId !== step.runId || approval.status !== "approved") return false;
      const action = approval.requestedAction as { skillId?: unknown; capability?: unknown } | undefined;
      return action?.skillId === step.skillId && action?.capability === step.capability;
    });
  }

  private async executeSkillStep(step: StepRecord): Promise<void> {
    this.db.updateStep(step.id, "running");
    this.emit({ runId: step.runId, stepId: step.id, type: "step.started", payload: step });
    this.emit({ runId: step.runId, stepId: step.id, type: "skill.execution.started", payload: { skillId: step.skillId, capability: step.capability } });
    try {
      if (!step.skillId || !step.capability) {
        throw new Error("Skill step is missing provider or capability.");
      }
      const provider = this.providers.find((item) => item.type === "skill");
      if (!provider) {
        throw new Error("No skill provider is registered.");
      }
      const { output } = await provider.execute({
        runId: step.runId,
        stepId: step.id,
        providerId: step.skillId,
        capabilityName: step.capability,
        input: step.input
      });
      this.db.updateStep(step.id, "completed", output);
      this.emit({ runId: step.runId, stepId: step.id, type: "skill.execution.completed", payload: output });
      this.emit({ runId: step.runId, stepId: step.id, type: "step.completed", payload: output });
    } catch (error) {
      const payload = { message: error instanceof Error ? error.message : String(error) };
      const run = this.db.getRun(step.runId);
      if (run?.status === "interrupted" || run?.status === "canceled") return;
      this.db.updateStep(step.id, "failed", undefined, payload);
      this.db.updateRunStatus(step.runId, "failed", new Date().toISOString());
      this.db.updateJobStatus(step.runId, "failed");
      this.emit({ runId: step.runId, stepId: step.id, type: "skill.execution.failed", payload });
      this.emit({ runId: step.runId, stepId: step.id, type: "step.failed", payload });
      this.emit({ runId: step.runId, type: "run.failed", payload });
      throw error;
    }
  }

  private emit(input: Omit<SunPilotEvent, "id" | "createdAt">): void {
    this.db.appendEvent({
      id: `evt_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      ...input
    });
  }
}
