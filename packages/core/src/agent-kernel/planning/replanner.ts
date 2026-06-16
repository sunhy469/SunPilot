import type { LlmProvider } from "../../llm/llm.provider.js";
import type {
  AgentPlan,
  AgentPlanStep,
  AgentContext,
  AgentObservation,
  AgentReflection,
  RoutedIntent,
  ToolCallSummary,
} from "../loop-types.js";
import type { SkillSummary } from "../tools/tool-types.js";

// ── Replan Types ────────────────────────────────────────────────────────

export type ReplanTrigger =
  | "tool_failed"
  | "goal_changed"
  | "approval_rejected"
  | "tool_result_insufficient"
  | "missing_parameters"
  | "max_iterations_approaching";

export interface ReplanInput {
  trigger: ReplanTrigger;
  /** The original plan being revised. */
  originalPlan: AgentPlan;
  /** Current context with latest tool results. */
  context: AgentContext;
  /** Latest observation from tool execution. */
  observation?: AgentObservation;
  /** Latest reflection result. */
  reflection?: AgentReflection;
  /** When trigger is goal_changed, the new user message. */
  newGoal?: string;
  /** When trigger is approval_rejected, the rejected skill id. */
  rejectedSkillId?: string;
  /** When trigger is tool_failed, the failed tool call summaries. */
  failedToolCalls?: ToolCallSummary[];
  /** Current iteration count. */
  iteration: number;
  /** Max allowed iterations. */
  maxIterations: number;
}

export interface ReplanResult {
  /** The revised plan (may be the same as original if no changes needed). */
  plan: AgentPlan;
  /** Steps that were removed compared to the original plan. */
  removedSteps: string[];
  /** Steps that were added compared to the original plan. */
  addedSteps: AgentPlanStep[];
  /** Steps that were modified. */
  modifiedSteps: string[];
  /** Human-readable summary of what changed. */
  summary: string;
  /** Whether the plan was actually changed. */
  changed: boolean;
}

export interface ReplannerDeps {
  /** List available skills for building alternative steps. */
  listSkills: () => Promise<SkillSummary[]>;
  /** Optional LLM for semantic replanning (complex cases). */
  llm?: LlmProvider;
}

/**
 * Replanner — adapts the agent plan when execution doesn't go as expected.
 *
 * Handles six trigger types:
 *   1. tool_failed          → generate alternative steps using different tools
 *   2. goal_changed         → rewrite subsequent (unexecuted) steps for new goal
 *   3. approval_rejected    → generate alternative path without the rejected tool
 *   4. tool_result_insufficient → add verification / detail steps
 *   5. missing_parameters   → insert clarification step into plan
 *   6. max_iterations_approaching → output remaining unfinished items
 *
 * The replanner is deterministic-first (rule-based) and falls back to LLM
 * for complex cases where the substitution isn't obvious.
 */
export class Replanner {
  constructor(private readonly deps: ReplannerDeps) {}

  async replan(input: ReplanInput): Promise<ReplanResult> {
    const { trigger, originalPlan } = input;

    switch (trigger) {
      case "tool_failed":
        return this.handleToolFailed(input);
      case "goal_changed":
        return this.handleGoalChanged(input);
      case "approval_rejected":
        return this.handleApprovalRejected(input);
      case "tool_result_insufficient":
        return this.handleToolResultInsufficient(input);
      case "missing_parameters":
        return this.handleMissingParameters(input);
      case "max_iterations_approaching":
        return this.handleMaxIterationsApproaching(input);
      default:
        return this.unchanged(originalPlan, "Unknown replan trigger");
    }
  }

  // ── Trigger handlers ───────────────────────────────────────────────

  /**
   * Tool failed — try to find alternative skills that achieve the same goal.
   * If no alternative exists, mark the step as failed_terminal.
   */
  private async handleToolFailed(input: ReplanInput): Promise<ReplanResult> {
    const { originalPlan, failedToolCalls, context } = input;
    if (!failedToolCalls || failedToolCalls.length === 0) {
      return this.unchanged(originalPlan, "No failed tool calls to replan");
    }

    const availableSkills = await this.deps.listSkills();
    const modifiedStepIds: string[] = [];

    let steps = [...originalPlan.steps];

    for (const failedCall of failedToolCalls) {
      const failedStepIdx = steps.findIndex(
        (s) => s.skillId === failedCall.skillId,
      );
      if (failedStepIdx < 0) continue;

      const failedStep = steps[failedStepIdx]!;

      // Try to find an alternative skill in the same category
      const alternatives = availableSkills.filter(
        (s) => {
          const origSkill = availableSkills.find(
            (as) => as.id === failedCall.skillId,
          );
          return (
            s.enabled &&
            s.id !== failedCall.skillId &&
            s.category === origSkill?.category &&
            !isRepairableFailure(failedCall.summary)
          );
        },
      );

      if (alternatives.length > 0) {
        // Replace the failed step with the best alternative
        const bestAlt = alternatives[0]!;
        const newStep: AgentPlanStep = {
          ...failedStep,
          id: `plan_step_replan_${crypto.randomUUID().slice(0, 8)}`,
          skillId: bestAlt.id,
          title: `${bestAlt.name} (替代 ${failedCall.name})`,
          description: `Alternative to failed step "${failedStep.title}": use ${bestAlt.name} (${bestAlt.id}).`,
        };
        steps = [
          ...steps.slice(0, failedStepIdx),
          newStep,
          ...steps.slice(failedStepIdx + 1),
        ];
        modifiedStepIds.push(failedStep.id);
      } else if (isRepairableFailure(failedCall.summary)) {
        // Repairable — keep the step but add a note to retry with fixed params
        const repairedStep: AgentPlanStep = {
          ...failedStep,
          id: `plan_step_repair_${crypto.randomUUID().slice(0, 8)}`,
          title: `${failedStep.title} (重试)`,
          description: `Retry ${failedStep.title} with repaired parameters. Previous failure: ${failedCall.summary}`,
        };
        steps = [
          ...steps.slice(0, failedStepIdx),
          repairedStep,
          ...steps.slice(failedStepIdx + 1),
        ];
        modifiedStepIds.push(failedStep.id);
      } else {
        // Terminal failure — remove the step and add a fallback reasoning step
        const fallbackStep: AgentPlanStep = {
          id: `plan_step_fallback_${crypto.randomUUID().slice(0, 8)}`,
          title: "Handle tool failure",
          description: `Tool "${failedCall.name}" failed terminally: ${failedCall.summary}. Explain to user and suggest alternatives.`,
          type: "reasoning",
          dependsOn:
            failedStep.dependsOn.length > 0
              ? failedStep.dependsOn
              : [steps[0]?.id ?? originalPlan.id].filter(Boolean),
          riskLevel: "low",
          status: "pending",
        };
        steps = [
          ...steps.slice(0, failedStepIdx),
          fallbackStep,
          ...steps.slice(failedStepIdx + 1),
        ];
        modifiedStepIds.push(failedStep.id);
      }
    }

    // Rebuild dependsOn chains for the modified plan
    steps = rebuildDependsOn(steps);

    const newPlan = this.buildRevisedPlan(originalPlan, steps);
    return {
      plan: newPlan,
      removedSteps: [],
      addedSteps: [],
      modifiedSteps: modifiedStepIds,
      summary: `Replanned after ${failedToolCalls.length} tool failure(s): ${failedToolCalls.map((tc) => tc.name).join(", ")}.`,
      changed: true,
    };
  }

  /**
   * User changed their goal mid-execution.
   * Keep completed steps, rewrite remaining steps for the new goal.
   */
  private async handleGoalChanged(input: ReplanInput): Promise<ReplanResult> {
    const { originalPlan, newGoal, context, observation } = input;
    if (!newGoal) {
      return this.unchanged(originalPlan, "No new goal provided");
    }

    // Identify which steps have already been executed
    const completedToolCallIds = new Set(
      (observation?.toolCalls ?? [])
        .filter((tc) => tc.status === "completed")
        .map((tc) => tc.skillId),
    );

    // Keep completed steps, drop pending ones
    const completedSteps = originalPlan.steps.filter(
      (s) =>
        s.type === "tool" &&
        s.skillId &&
        completedToolCallIds.has(s.skillId),
    );
    const removedStepIds = originalPlan.steps
      .filter((s) => !completedSteps.includes(s))
      .map((s) => s.id);

    // Build new tool step for the new goal (deterministic)
    const availableSkills = await this.deps.listSkills();
    const matchingSkills = availableSkills.filter(
      (s) =>
        s.enabled &&
        (s.name.toLowerCase().includes(newGoal.toLowerCase()) ||
          s.description.toLowerCase().includes(newGoal.toLowerCase()) ||
          newGoal.toLowerCase().includes(s.name.toLowerCase())),
    );

    const newToolSteps: AgentPlanStep[] = matchingSkills
      .slice(0, 3)
      .map((skill, i) => ({
        id: `plan_step_newgoal_${crypto.randomUUID().slice(0, 8)}`,
        title: skill.name,
        description: `Use ${skill.name} (${skill.id}) for updated goal: ${newGoal}`,
        type: "tool" as const,
        skillId: skill.id,
        dependsOn:
          i === 0 && completedSteps.length > 0
            ? [completedSteps[completedSteps.length - 1]!.id]
            : i === 0
              ? []
              : [`plan_step_newgoal_${i - 1}`],
        riskLevel: skill.riskHints.defaultRisk,
        status: "pending" as const,
      }));

    const reasonStepId = `plan_step_newgoal_reason_${crypto.randomUUID().slice(0, 8)}`;
    const responseStepId = `plan_step_newgoal_response_${crypto.randomUUID().slice(0, 8)}`;

    const steps: AgentPlanStep[] = [
      ...completedSteps,
      ...newToolSteps,
      {
        id: reasonStepId,
        title: "Reason about updated results",
        description: "Inspect tool observations from the new goal and prepare response.",
        type: "reasoning",
        dependsOn:
          newToolSteps.length > 0
            ? [newToolSteps[newToolSteps.length - 1]!.id]
            : completedSteps.length > 0
              ? [completedSteps[completedSteps.length - 1]!.id]
              : [],
        riskLevel: "low",
        status: "pending",
      },
      {
        id: responseStepId,
        title: "Compose response",
        description: "Return a concise user-facing response for the updated goal.",
        type: "response",
        dependsOn: [reasonStepId],
        riskLevel: "low",
        status: "pending",
      },
    ];

    const newPlan = this.buildRevisedPlan(originalPlan, steps, newGoal);
    return {
      plan: newPlan,
      removedSteps: removedStepIds,
      addedSteps: newToolSteps,
      modifiedSteps: [],
      summary: `Goal changed from "${originalPlan.goal}" to "${newGoal}". Kept ${completedSteps.length} completed step(s), planned ${newToolSteps.length} new tool step(s).`,
      changed: true,
    };
  }

  /**
   * Approval was rejected — generate an alternative path without the tool.
   */
  private async handleApprovalRejected(
    input: ReplanInput,
  ): Promise<ReplanResult> {
    const { originalPlan, rejectedSkillId } = input;
    if (!rejectedSkillId) {
      return this.unchanged(originalPlan, "No rejected skill specified");
    }

    // Find the step with the rejected skill
    const rejectedStepIdx = originalPlan.steps.findIndex(
      (s) => s.skillId === rejectedSkillId,
    );

    if (rejectedStepIdx < 0) {
      return this.unchanged(
        originalPlan,
        `Rejected skill ${rejectedSkillId} not found in plan`,
      );
    }

    const rejectedStep = originalPlan.steps[rejectedStepIdx]!;

    // Try to find a lower-risk alternative
    const availableSkills = await this.deps.listSkills();
    const lowRiskAlt = availableSkills.find(
      (s) =>
        s.enabled &&
        s.category ===
          availableSkills.find((as) => as.id === rejectedSkillId)?.category &&
        s.id !== rejectedSkillId &&
        s.riskHints.defaultRisk !== "high" &&
        s.riskHints.defaultRisk !== "critical",
    );

    let steps = [...originalPlan.steps];

    if (lowRiskAlt) {
      // Replace with lower-risk alternative
      const altStep: AgentPlanStep = {
        ...rejectedStep,
        id: `plan_step_alt_${crypto.randomUUID().slice(0, 8)}`,
        skillId: lowRiskAlt.id,
        title: `${lowRiskAlt.name} (无需审批)`,
        description: `Use ${lowRiskAlt.name} instead of the rejected "${rejectedStep.title}".`,
        riskLevel: lowRiskAlt.riskHints.defaultRisk,
      };
      steps = [
        ...steps.slice(0, rejectedStepIdx),
        altStep,
        ...steps.slice(rejectedStepIdx + 1),
      ];
    } else {
      // No alternative — add a reasoning step to explain the situation
      const explainStep: AgentPlanStep = {
        id: `plan_step_explain_${crypto.randomUUID().slice(0, 8)}`,
        title: "Explain rejected tool",
        description: `Tool "${rejectedStep.title}" was rejected by user. Explain the situation and ask if user wants to proceed differently.`,
        type: "reasoning",
        dependsOn:
          rejectedStep.dependsOn.length > 0
            ? rejectedStep.dependsOn
            : rejectedStepIdx > 0
              ? [steps[rejectedStepIdx - 1]!.id]
              : [],
        riskLevel: "low",
        status: "pending",
      };
      steps = [
        ...steps.slice(0, rejectedStepIdx),
        explainStep,
        ...steps.slice(rejectedStepIdx + 1),
      ];
    }

    steps = rebuildDependsOn(steps);

    const newPlan = this.buildRevisedPlan(originalPlan, steps);
    return {
      plan: newPlan,
      removedSteps: [rejectedStep.id],
      addedSteps: [],
      modifiedSteps: [rejectedStep.id],
      summary: `Rejected tool "${rejectedStep.title}" (${rejectedSkillId}). ${lowRiskAlt ? `Replaced with "${lowRiskAlt.name}".` : "No low-risk alternative available — asking user for guidance."}`,
      changed: true,
    };
  }

  /**
   * Tool result insufficient — add detail/verification steps after search.
   */
  private async handleToolResultInsufficient(
    input: ReplanInput,
  ): Promise<ReplanResult> {
    const { originalPlan, reflection } = input;
    const missingInfo = reflection?.missingInfo ?? [];

    if (missingInfo.length === 0) {
      return this.unchanged(
        originalPlan,
        "No missing info to address with additional steps",
      );
    }

    const availableSkills = await this.deps.listSkills();

    // Find skills that can provide the missing information
    const detailSkills = availableSkills.filter(
      (s) =>
        s.enabled &&
        missingInfo.some(
          (info) =>
            s.name.toLowerCase().includes(info.toLowerCase()) ||
            s.description.toLowerCase().includes(info.toLowerCase()),
        ),
    );

    // Insert detail/verification steps before the reasoning step
    const reasoningIdx = originalPlan.steps.findIndex(
      (s) => s.type === "reasoning",
    );
    const insertIdx = reasoningIdx >= 0 ? reasoningIdx : originalPlan.steps.length;

    const verificationSteps: AgentPlanStep[] = detailSkills.map(
      (skill, i) => ({
        id: `plan_step_verify_${crypto.randomUUID().slice(0, 8)}`,
        title: `Verify: ${skill.name}`,
        description: `Check ${missingInfo[i] ?? "missing info"} using ${skill.name} (${skill.id}).`,
        type: "tool" as const,
        skillId: skill.id,
        dependsOn:
          insertIdx > 0 && i === 0
            ? [originalPlan.steps[insertIdx - 1]!.id]
            : i > 0
              ? [`plan_step_verify_${i - 1}`]
              : [],
        riskLevel: skill.riskHints.defaultRisk,
        status: "pending" as const,
      }),
    );

    const steps = [
      ...originalPlan.steps.slice(0, insertIdx),
      ...verificationSteps,
      ...originalPlan.steps.slice(insertIdx),
    ];

    const newPlan = this.buildRevisedPlan(originalPlan, steps);
    return {
      plan: newPlan,
      removedSteps: [],
      addedSteps: verificationSteps,
      modifiedSteps: [],
      summary: `Added ${verificationSteps.length} verification step(s) to address missing info: ${missingInfo.join(", ")}.`,
      changed: true,
    };
  }

  /**
   * Missing parameters — insert a clarification step before tool execution.
   */
  private async handleMissingParameters(
    input: ReplanInput,
  ): Promise<ReplanResult> {
    const { originalPlan, reflection } = input;
    const missingInfo = reflection?.missingInfo ?? [];

    // Find the first unexecuted tool step
    const toolStepIdx = originalPlan.steps.findIndex((s) => s.type === "tool");

    const clarificationStep: AgentPlanStep = {
      id: `plan_step_clarify_${crypto.randomUUID().slice(0, 8)}`,
      title: "Request clarification",
      description:
        missingInfo.length > 0
          ? `Ask user to provide: ${missingInfo.join(", ")}.`
          : "Ask user for missing parameters needed to proceed.",
      type: "reasoning",
      dependsOn:
        toolStepIdx > 0
          ? [originalPlan.steps[toolStepIdx - 1]!.id]
          : [],
      riskLevel: "low",
      status: "pending",
    };

    const insertIdx = toolStepIdx >= 0 ? toolStepIdx : 0;
    const steps = [
      ...originalPlan.steps.slice(0, insertIdx),
      clarificationStep,
      ...originalPlan.steps.slice(insertIdx),
    ];

    const newPlan = this.buildRevisedPlan(originalPlan, steps);
    return {
      plan: newPlan,
      removedSteps: [],
      addedSteps: [clarificationStep],
      modifiedSteps: [],
      summary: `Inserted clarification step for missing info: ${missingInfo.join(", ") || "unknown parameters"}.`,
      changed: true,
    };
  }

  /**
   * Approaching max iterations — output remaining unfinished items.
   */
  private async handleMaxIterationsApproaching(
    input: ReplanInput,
  ): Promise<ReplanResult> {
    const { originalPlan, observation } = input;

    const completedToolCallIds = new Set(
      (observation?.toolCalls ?? [])
        .filter((tc) => tc.status === "completed")
        .map((tc) => tc.skillId),
    );

    const pendingSteps = originalPlan.steps.filter(
      (s) =>
        s.type === "tool" &&
        s.skillId &&
        !completedToolCallIds.has(s.skillId),
    );

    if (pendingSteps.length === 0) {
      return this.unchanged(originalPlan, "All tool steps completed");
    }

    // Replace remaining tool steps with a summary of what's unfinished
    const firstToolIdx = originalPlan.steps.findIndex(
      (s) => s.type === "tool" && !completedToolCallIds.has(s.skillId ?? ""),
    );

    if (firstToolIdx < 0) {
      return this.unchanged(originalPlan, "No pending tool steps to summarize");
    }

    const unfinishedSummary = pendingSteps
      .map((s) => `- ${s.title}: ${s.description}`)
      .join("\n");

    const summaryStep: AgentPlanStep = {
      id: `plan_step_unfinished_${crypto.randomUUID().slice(0, 8)}`,
      title: "Summarize unfinished work",
      description: `List remaining tasks that could not be completed:\n${unfinishedSummary}`,
      type: "reasoning",
      dependsOn: firstToolIdx > 0 ? [originalPlan.steps[firstToolIdx - 1]!.id] : [],
      riskLevel: "low",
      status: "pending",
    };

    const maxIterResponse: AgentPlanStep = {
      id: `plan_step_maxiter_response_${crypto.randomUUID().slice(0, 8)}`,
      title: "Compose response with unfinished items",
      description: "Tell the user what was completed and what remains unfinished.",
      type: "response",
      dependsOn: [summaryStep.id],
      riskLevel: "low",
      status: "pending",
    };

    const steps = [
      ...originalPlan.steps.slice(0, firstToolIdx),
      summaryStep,
      maxIterResponse,
    ];

    const removedStepIds = pendingSteps.map((s) => s.id);

    const newPlan = this.buildRevisedPlan(originalPlan, steps);
    return {
      plan: newPlan,
      removedSteps: removedStepIds,
      addedSteps: [summaryStep],
      modifiedSteps: [],
      summary: `Approaching max iterations (${input.iteration}/${input.maxIterations}). Summarizing ${pendingSteps.length} unfinished step(s) for user.`,
      changed: true,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private unchanged(plan: AgentPlan, reason: string): ReplanResult {
    return {
      plan,
      removedSteps: [],
      addedSteps: [],
      modifiedSteps: [],
      summary: reason,
      changed: false,
    };
  }

  private buildRevisedPlan(
    original: AgentPlan,
    steps: AgentPlanStep[],
    newGoal?: string,
  ): AgentPlan {
    return {
      ...original,
      id: `plan_replan_${crypto.randomUUID().slice(0, 8)}`,
      goal: newGoal ?? original.goal,
      summary: `Revised plan (from ${original.id}): ${original.summary}`,
      steps,
      riskLevel: maxStepRisk(steps),
      requiresApproval: steps.some(
        (s) => s.riskLevel === "high" || s.riskLevel === "critical",
      ),
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isRepairableFailure(summary: string): boolean {
  return (
    /timeout/i.test(summary) ||
    /transient/i.test(summary) ||
    /rate limit/i.test(summary) ||
    /invalid (parameter|argument|input)/i.test(summary) ||
    /missing (parameter|argument|field|required)/i.test(summary) ||
    /connection refused/i.test(summary) ||
    /temporary/i.test(summary) ||
    /retry/i.test(summary)
  );
}

function maxStepRisk(
  steps: AgentPlanStep[],
): "low" | "medium" | "high" | "critical" {
  return steps.reduce<"low" | "medium" | "high" | "critical">(
    (current, step) => {
      const order = { low: 0, medium: 1, high: 2, critical: 3 };
      return order[step.riskLevel] > order[current]
        ? step.riskLevel
        : current;
    },
    "low",
  );
}

/**
 * Rebuild dependsOn chains so they're consistent with the new step order.
 * Each step depends on the previous step, unless it has explicit dependencies.
 */
function rebuildDependsOn(steps: AgentPlanStep[]): AgentPlanStep[] {
  return steps.map((step, i) => {
    if (step.dependsOn.length > 0) {
      // Keep explicit dependencies that still exist
      const validDeps = step.dependsOn.filter((depId) =>
        steps.some((s) => s.id === depId),
      );
      if (validDeps.length > 0) {
        return { ...step, dependsOn: validDeps };
      }
    }
    // Default: depend on previous step
    return {
      ...step,
      dependsOn: i > 0 ? [steps[i - 1]!.id] : [],
    };
  });
}
