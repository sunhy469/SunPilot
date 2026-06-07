import type {
  ApprovalRecord,
  RunMode,
  RunRecord,
  StepRecord,
  SunPilotEvent,
} from "@sunpilot/protocol";
import type { WorkflowRegistry } from "@sunpilot/workflow";
import { conflict, notFound } from "../errors/index.js";
import type { ToolCapability, ToolProvider } from "../providers/index.js";
import type { RuntimeStore } from "./runtime.store.js";

/**
 * SunPilotRuntime — 旧版 Workflow 执行引擎。
 *
 * 与 Agent Loop 的关系：
 * - Agent Loop 是新的"每次用户交互走完整状态机"引擎
 * - SunPilotRuntime 是旧的 Workflow 执行引擎，支持 plan→approve→execute 的步骤式流程
 * - 当 ToolDecisionEngine 选择 workflow.* 开头的 skill 时，
 *   由 composition-root 的 toolExecutor 桥接到 Runtime.createRun
 *
 * Workflow 和 Skill 的区别：
 * - Skill：单个能力（读文件、写文件、执行命令等），同步执行，返回结果
 * - Workflow：多步骤编排（计划→审批→步骤执行），异步执行，产生 Run 和多个 Step
 *
 * Runtime 本身是审批驱动的：每个高风险的 step 执行前需要创建 Approval，等待用户 approve/reject。
 */
export class SunPilotRuntime {
  constructor(
    private readonly db: RuntimeStore,
    private readonly workflows: WorkflowRegistry,
    private readonly providers: ToolProvider[],
  ) {}

  async listCapabilities() {
    const capabilityLists = await Promise.all(
      this.providers.map((provider) => provider.listCapabilities()),
    );
    return capabilityLists.flat();
  }

  async createRun(
    input: unknown,
    workflowId: string | undefined,
    mode: RunMode = "approval_required",
  ): Promise<RunRecord> {
    if (!workflowId) {
      throw notFound("workflowId is required.");
    }
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
      context: { plan },
    };
    await this.db.insertRun(run);
    await this.db.insertJob({
      id: `job_${crypto.randomUUID()}`,
      runId: run.id,
      status: "pending",
      payload: { workflowId, mode },
    });
    await this.emit({ runId: run.id, type: "run.created", payload: run });
    await this.emit({
      runId: run.id,
      type: "workflow.selected",
      payload: { workflowId },
    });
    await this.emit({ runId: run.id, type: "workflow.planned", payload: plan });

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
        input: planned.input,
      };
      await this.db.insertStep(step);
      await this.emit({
        runId: run.id,
        stepId: step.id,
        type: "step.created",
        payload: step,
      });
    }

    if (mode === "dry_run") {
      for (const step of await this.db.listSteps(run.id)) {
        await this.db.updateStep(step.id, "skipped", { dryRun: true });
      }
      await this.db.updateRunStatus(
        run.id,
        "completed",
        new Date().toISOString(),
      );
      await this.db.updateJobStatus(run.id, "completed");
      await this.emit({
        runId: run.id,
        type: "run.completed",
        payload: { dryRun: true },
      });
      return (await this.db.getRun(run.id))!;
    }

    await this.continueRun(run.id);
    return (await this.db.getRun(run.id))!;
  }

  async approve(
    approvalId: string,
    decision: unknown,
  ): Promise<ApprovalRecord> {
    await this.ensureApprovalCanBeDecided(approvalId);
    const approval = await this.db.decideApproval(
      approvalId,
      "approved",
      decision,
    );
    if (!approval) throw await this.approvalDecisionError(approvalId);
    await this.db.audit({
      runId: approval.runId,
      stepId: approval.stepId,
      actor: "local-user",
      action: "approval.approve",
      target: approval.id,
      risk: approval.risk,
      payload: decision,
    });
    await this.emit({
      runId: approval.runId,
      stepId: approval.stepId,
      type: "approval.approved",
      payload: approval,
    });
    if (approval.stepId) {
      const step = (await this.db.listSteps(approval.runId)).find(
        (item) => item.id === approval.stepId,
      );
      if (step?.type === "approval") {
        await this.db.updateStep(approval.stepId, "completed", {
          approved: true,
        });
        await this.emit({
          runId: approval.runId,
          stepId: approval.stepId,
          type: "step.completed",
          payload: { approvalId },
        });
      } else if (step?.type === "skill") {
        await this.db.updateStep(approval.stepId, "pending");
      }
    }
    await this.continueRun(approval.runId);
    return approval;
  }

  async reject(approvalId: string, decision: unknown): Promise<ApprovalRecord> {
    await this.ensureApprovalCanBeDecided(approvalId);
    const approval = await this.db.decideApproval(
      approvalId,
      "rejected",
      decision,
    );
    if (!approval) throw await this.approvalDecisionError(approvalId);
    await this.db.audit({
      runId: approval.runId,
      stepId: approval.stepId,
      actor: "local-user",
      action: "approval.reject",
      target: approval.id,
      risk: approval.risk,
      payload: decision,
    });
    await this.emit({
      runId: approval.runId,
      stepId: approval.stepId,
      type: "approval.rejected",
      payload: approval,
    });
    if (approval.stepId)
      await this.db.updateStep(approval.stepId, "cancelled", undefined, {
        rejected: true,
      });
    await this.db.updateRunStatus(
      approval.runId,
      "cancelled",
      new Date().toISOString(),
    );
    await this.db.updateJobStatus(approval.runId, "cancelled");
    await this.emit({
      runId: approval.runId,
      type: "run.cancelled",
      payload: { approvalId },
    });
    return approval;
  }

  async interrupt(runId: string): Promise<RunRecord> {
    const run = await this.db.getRun(runId);
    if (!run) {
      throw notFound(`Unknown run: ${runId}`);
    }
    for (const provider of this.providers) provider.interrupt?.(runId);
    await this.db.updateRunStatus(
      runId,
      "interrupted",
      new Date().toISOString(),
    );
    await this.db.updateJobStatus(runId, "interrupted");
    for (const step of await this.db.listSteps(runId)) {
      if (
        !["completed", "failed", "skipped", "cancelled", "interrupted"].includes(
          step.status,
        )
      ) {
        await this.db.updateStep(step.id, "interrupted", undefined, {
          reason: "run interrupted",
        });
        await this.emit({
          runId,
          stepId: step.id,
          type: "step.interrupted",
          payload: { actor: "local-user" },
        });
      }
    }
    await this.emit({
      runId,
      type: "run.interrupted",
      payload: { actor: "local-user" },
    });
    return (await this.db.getRun(runId))!;
  }

  async cancel(runId: string): Promise<RunRecord> {
    const run = await this.db.getRun(runId);
    if (!run) {
      throw notFound(`Unknown run: ${runId}`);
    }
    for (const provider of this.providers) provider.interrupt?.(runId);
    await this.db.updateRunStatus(runId, "cancelled", new Date().toISOString());
    await this.db.updateJobStatus(runId, "cancelled");
    for (const step of await this.db.listSteps(runId)) {
      if (
        !["completed", "failed", "skipped", "cancelled", "interrupted"].includes(
          step.status,
        )
      ) {
        await this.db.updateStep(step.id, "cancelled", undefined, {
          reason: "run cancelled",
        });
      }
    }
    await this.db.audit({
      runId,
      actor: "local-user",
      action: "run.cancel",
      target: runId,
      payload: { actor: "local-user" },
    });
    await this.emit({
      runId,
      type: "run.cancelled",
      payload: { actor: "local-user" },
    });
    return (await this.db.getRun(runId))!;
  }

  async retry(runId: string): Promise<RunRecord> {
    const run = await this.db.getRun(runId);
    if (!run) {
      throw notFound(`Unknown run: ${runId}`);
    }
    const retry = await this.createRun(run.input, run.workflowId, run.mode);
    retry.context.retryOf = runId;
    await this.db.updateRunContext(retry.id, retry.context);
    await this.db.audit({
      runId,
      actor: "daemon",
      action: "run.retry",
      target: retry.id,
      payload: { sourceRunId: runId },
    });
    await this.emit({
      runId,
      type: "run.interrupted",
      payload: { retryRunId: retry.id, reason: "retry requested" },
    });
    return retry;
  }

  private async continueRun(runId: string): Promise<void> {
    const run = await this.db.getRun(runId);
    if (
      !run ||
      ["completed", "cancelled", "failed", "interrupted"].includes(run.status)
    )
      return;

    await this.db.updateRunStatus(runId, "running");
    await this.db.updateJobStatus(runId, "running", true);
    await this.emit({ runId, type: "run.started", payload: {} });

    const steps = await this.db.listSteps(runId);
    for (const step of steps) {
      if (step.status === "completed") continue;
      if (step.status === "waiting_approval") {
        await this.db.updateRunStatus(runId, "waiting_approval");
        await this.db.updateJobStatus(runId, "waiting_approval");
        return;
      }
      if (step.type === "approval") {
        await this.requestApproval(step);
        await this.db.updateRunStatus(runId, "waiting_approval");
        await this.db.updateJobStatus(runId, "waiting_approval");
        await this.db.updateStep(step.id, "waiting_approval");
        return;
      }
      if (step.type === "skill") {
        const capability = await this.capabilityForStep(step);
        if (
          this.requiresApproval(capability) &&
          !(await this.hasApprovedCapability(step))
        ) {
          await this.requestApproval(step, capability);
          await this.db.updateRunStatus(runId, "waiting_approval");
          await this.db.updateJobStatus(runId, "waiting_approval");
          await this.db.updateStep(step.id, "waiting_approval");
          return;
        }
        await this.executeSkillStep(step);
        const current = await this.db.getRun(runId);
        if (
          !current ||
          ["completed", "cancelled", "failed", "interrupted"].includes(
            current.status,
          )
        )
          return;
      }
    }

    const current = await this.db.getRun(runId);
    if (
      !current ||
      ["completed", "cancelled", "failed", "interrupted"].includes(
        current.status,
      )
    )
      return;
    await this.db.updateRunStatus(runId, "completed", new Date().toISOString());
    await this.db.updateJobStatus(runId, "completed");
    await this.emit({
      runId,
      type: "run.completed",
      payload: { artifacts: await this.db.listArtifacts(runId) },
    });
  }

  private async requestApproval(
    step: StepRecord,
    capability?: ToolCapability,
  ): Promise<ApprovalRecord> {
    const existing = (await this.db.listApprovals()).find(
      (approval) =>
        approval.stepId === step.id && approval.status === "pending",
    );
    if (existing) return existing;

    const now = new Date().toISOString();
    const input = (step.input ?? {}) as {
      title?: string;
      reason?: string;
      requestedAction?: unknown;
    };
    const approval: ApprovalRecord = {
      id: `approval_${crypto.randomUUID()}`,
      runId: step.runId,
      stepId: step.id,
      status: "pending",
      risk:
        capability?.risk === "critical"
          ? "critical"
          : capability?.risk === "medium"
            ? "medium"
            : "high",
      title:
        input.title ?? (capability ? `Approve ${capability.title}` : step.name),
      reason:
        input.reason ??
        (capability
          ? `${capability.risk} risk capability requires approval before execution.`
          : "This action requires approval."),
      requestedAction:
        input.requestedAction ??
        (capability
          ? {
              skillId: step.skillId,
              capability: step.capability,
              input: step.input,
            }
          : step.input),
      createdAt: now,
    };
    await this.db.insertApproval(approval);
    await this.db.audit({
      runId: step.runId,
      stepId: step.id,
      actor: "daemon",
      action: "approval.request",
      target: approval.id,
      risk: approval.risk,
      payload: approval.requestedAction,
    });
    await this.emit({
      runId: step.runId,
      stepId: step.id,
      type: "approval.requested",
      payload: approval,
    });
    return approval;
  }

  private async approvalDecisionError(approvalId: string): Promise<Error> {
    const existing = await this.db.getApproval(approvalId);
    if (!existing) return notFound(`Unknown approval: ${approvalId}`);
    return conflict(`Approval is already ${existing.status}: ${approvalId}`);
  }

  private async ensureApprovalCanBeDecided(
    approvalId: string,
  ): Promise<ApprovalRecord> {
    const approval = await this.db.getApproval(approvalId);
    if (!approval) throw notFound(`Unknown approval: ${approvalId}`);
    if (approval.status !== "pending")
      throw conflict(`Approval is already ${approval.status}: ${approvalId}`);
    await this.ensureApprovalRunCanBeDecided(approval);
    return approval;
  }

  private async ensureApprovalRunCanBeDecided(
    approval: ApprovalRecord,
  ): Promise<void> {
    const run = await this.db.getRun(approval.runId);
    if (!run) throw notFound(`Unknown run: ${approval.runId}`);
    if (
      ["completed", "cancelled", "failed", "interrupted"].includes(run.status)
    ) {
      throw conflict(`Run is already ${run.status}: ${approval.runId}`);
    }
  }

  private async capabilityForStep(
    step: StepRecord,
  ): Promise<ToolCapability | undefined> {
    if (!step.skillId || !step.capability) return undefined;
    const capabilities = await this.listCapabilities();
    return capabilities.find(
      (item) =>
        item.providerId === step.skillId &&
        item.capabilityName === step.capability,
    );
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

  private async hasApprovedCapability(step: StepRecord): Promise<boolean> {
    return (await this.db.listApprovals()).some((approval) => {
      if (approval.runId !== step.runId || approval.status !== "approved")
        return false;
      const action = approval.requestedAction as
        | { skillId?: unknown; capability?: unknown }
        | undefined;
      return (
        action?.skillId === step.skillId &&
        action?.capability === step.capability
      );
    });
  }

  private async executeSkillStep(step: StepRecord): Promise<void> {
    await this.db.updateStep(step.id, "running");
    await this.emit({
      runId: step.runId,
      stepId: step.id,
      type: "step.started",
      payload: step,
    });
    await this.emit({
      runId: step.runId,
      stepId: step.id,
      type: "skill.execution.started",
      payload: { skillId: step.skillId, capability: step.capability },
    });
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
        input: step.input,
      });
      await this.db.updateStep(step.id, "completed", output);
      await this.emit({
        runId: step.runId,
        stepId: step.id,
        type: "skill.execution.completed",
        payload: output,
      });
      await this.emit({
        runId: step.runId,
        stepId: step.id,
        type: "step.completed",
        payload: output,
      });
    } catch (error) {
      const payload = {
        message: error instanceof Error ? error.message : String(error),
      };
      const run = await this.db.getRun(step.runId);
      if (run?.status === "interrupted" || run?.status === "cancelled") return;
      await this.db.updateStep(step.id, "failed", undefined, payload);
      await this.db.updateRunStatus(
        step.runId,
        "failed",
        new Date().toISOString(),
      );
      await this.db.updateJobStatus(step.runId, "failed");
      await this.emit({
        runId: step.runId,
        stepId: step.id,
        type: "skill.execution.failed",
        payload,
      });
      await this.emit({
        runId: step.runId,
        stepId: step.id,
        type: "step.failed",
        payload,
      });
      await this.emit({ runId: step.runId, type: "run.failed", payload });
      throw error;
    }
  }

  private async emit(
    input: Omit<SunPilotEvent, "id" | "createdAt">,
  ): Promise<void> {
    await this.db.appendEvent({
      id: `evt_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      ...input,
    });
  }
}
