import type {
  AgentPlan,
  AgentPlanStep,
  AgentContext,
  RiskLevel,
  Permission,
} from "../loop-types.js";
import type { SkillSummary } from "../tools/tool-types.js";

// ── Validation Result Types ────────────────────────────────────────────

export interface PlanValidationIssue {
  stepId?: string;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface PlanValidationResult {
  valid: boolean;
  issues: PlanValidationIssue[];
  /** Step IDs that are executable without modification. */
  executableSteps: string[];
  /** Step IDs that need attention before execution. */
  blockedSteps: string[];
}

export interface PlanValidatorDeps {
  /** List currently available/enabled skills to check plan executability. */
  listSkills: () => Promise<SkillSummary[]>;
}

/**
 * PlanValidator — structural and semantic validation of agent plans.
 *
 * Runs before tool execution to catch:
 *  - missing targets, inputs, or dependencies
 *  - circular dependencies between steps
 *  - risk/permission mismatches
 *  - unmarked approval steps
 *  - steps that can't be executed with current tools
 *  - open steps without verifiable completion criteria
 *
 * Validation is deterministic (no LLM) so it's fast, auditable, and
 * always produces the same result for the same plan.
 */
export class PlanValidator {
  constructor(private readonly deps: PlanValidatorDeps) {}

  async validate(plan: AgentPlan): Promise<PlanValidationResult> {
    const issues: PlanValidationIssue[] = [];
    const availableSkills = await this.deps.listSkills();
    const availableSkillIds = new Set(
      availableSkills.map((s) => s.id),
    );

    // ── Step-level checks ──────────────────────────────────────────
    for (const step of plan.steps) {
      // 1. Tool steps must reference a skill
      if (step.type === "tool" && !step.skillId) {
        issues.push({
          stepId: step.id,
          severity: "error",
          code: "MISSING_SKILL_ID",
          message: `Tool step "${step.title}" has no skillId.`,
        });
      }

      // 2. Check skill availability
      if (step.type === "tool" && step.skillId) {
        if (!availableSkillIds.has(step.skillId)) {
          issues.push({
            stepId: step.id,
            severity: "error",
            code: "SKILL_NOT_AVAILABLE",
            message: `Tool step "${step.title}" references skill "${step.skillId}" which is not enabled.`,
          });
        }
      }

      // 3. Tool step missing input when schema requires it
      if (
        step.type === "tool" &&
        step.skillId &&
        availableSkillIds.has(step.skillId)
      ) {
        const skill = availableSkills.find((s) => s.id === step.skillId);
        if (skill?.inputSchema) {
          const requiredFields = extractRequiredFields(skill.inputSchema);
          const providedFields = Object.keys(step.input ?? {});
          const missingFields = requiredFields.filter(
            (f) => !providedFields.includes(f),
          );
          if (missingFields.length > 0) {
            issues.push({
              stepId: step.id,
              severity: "warning",
              code: "MISSING_REQUIRED_INPUT",
              message: `Tool step "${step.title}" is missing required input fields: ${missingFields.join(", ")}.`,
            });
          }
        }
      }

      // 4. Steps without completion criteria
      if (
        step.type !== "tool" &&
        step.type !== "approval" &&
        !step.expectedOutput
      ) {
        issues.push({
          stepId: step.id,
          severity: "warning",
          code: "NO_COMPLETION_CRITERIA",
          message: `Step "${step.title}" (type: ${step.type}) has no expectedOutput — completion may be ambiguous.`,
        });
      }

      // 5. Approval steps should have riskLevel >= high
      if (
        step.type === "approval" &&
        step.riskLevel !== "high" &&
        step.riskLevel !== "critical"
      ) {
        issues.push({
          stepId: step.id,
          severity: "warning",
          code: "APPROVAL_STEP_LOW_RISK",
          message: `Approval step "${step.title}" has risk level "${step.riskLevel}" — consider if approval is actually needed.`,
        });
      }
    }

    // ── Dependency checks ───────────────────────────────────────────
    const stepIds = new Set(plan.steps.map((s) => s.id));

    // Check dangling dependencies
    for (const step of plan.steps) {
      for (const depId of step.dependsOn) {
        if (!stepIds.has(depId)) {
          issues.push({
            stepId: step.id,
            severity: "error",
            code: "DANGLING_DEPENDENCY",
            message: `Step "${step.title}" depends on "${depId}" which is not in the plan.`,
          });
        }
      }
    }

    // Check for circular dependencies
    const cycles = detectCycles(plan.steps);
    for (const cycle of cycles) {
      issues.push({
        severity: "error",
        code: "CIRCULAR_DEPENDENCY",
        message: `Circular dependency detected: ${cycle.join(" → ")}.`,
      });
    }

    // ── Plan-level checks ───────────────────────────────────────────

    // 6. Plan goal must be non-empty
    if (!plan.goal || plan.goal.trim().length === 0) {
      issues.push({
        severity: "warning",
        code: "EMPTY_GOAL",
        message: "Plan has an empty goal — execution may diverge from user intent.",
      });
    }

    // 7. High/critical risk steps should have requiresApproval set
    const highRiskSteps = plan.steps.filter(
      (s) => s.riskLevel === "high" || s.riskLevel === "critical",
    );
    if (highRiskSteps.length > 0 && !plan.requiresApproval) {
      issues.push({
        severity: "warning",
        code: "HIGH_RISK_NO_APPROVAL",
        message: `Plan has ${highRiskSteps.length} high/critical risk step(s) but requiresApproval is false.`,
      });
    }

    // 8. Risk-level mismatch between step and its skill
    for (const step of plan.steps) {
      if (step.type === "tool" && step.skillId) {
        const skill = availableSkills.find((s) => s.id === step.skillId);
        if (skill) {
          const skillRisk = skill.riskHints.defaultRisk;
          const stepRisk = step.riskLevel;
          if (riskOrder(stepRisk) < riskOrder(skillRisk)) {
            issues.push({
              stepId: step.id,
              severity: "warning",
              code: "RISK_DOWNGRADE",
              message: `Step "${step.title}" has risk "${stepRisk}" but skill "${skill.id}" has default risk "${skillRisk}".`,
            });
          }
        }
      }
    }

    // 9. High-risk steps should check destructive args alignment
    for (const step of plan.steps) {
      if (
        step.type === "tool" &&
        step.skillId &&
        (step.riskLevel === "high" || step.riskLevel === "critical")
      ) {
        const skill = availableSkills.find((s) => s.id === step.skillId);
        if (skill?.riskHints.destructiveArgs) {
          const destructiveProvided = skill.riskHints.destructiveArgs.filter(
            (arg) => arg in (step.input ?? {}),
          );
          if (destructiveProvided.length > 0) {
            issues.push({
              stepId: step.id,
              severity: "warning",
              code: "DESTRUCTIVE_ARGS_PROVIDED",
              message: `Step "${step.title}" provides destructive arguments: ${destructiveProvided.join(", ")}. Ensure approval is required.`,
            });
          }
        }
      }
    }

    // ── Compute step status ─────────────────────────────────────────
    const errorStepIds = new Set(
      issues
        .filter((i) => i.severity === "error" && i.stepId)
        .map((i) => i.stepId!),
    );
    const blockedSteps = plan.steps
      .filter((s) => errorStepIds.has(s.id))
      .map((s) => s.id);
    const executableSteps = plan.steps
      .filter((s) => !errorStepIds.has(s.id))
      .map((s) => s.id);

    return {
      valid: issues.filter((i) => i.severity === "error").length === 0,
      issues,
      executableSteps,
      blockedSteps,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function riskOrder(r: RiskLevel): number {
  return { low: 0, medium: 1, high: 2, critical: 3 }[r];
}

/**
 * Extract required field names from a JSON Schema object.
 * Handles simple `required` array at the top level.
 */
function extractRequiredFields(schema: Record<string, unknown>): string[] {
  if (Array.isArray(schema.required)) {
    return schema.required.filter(
      (f): f is string => typeof f === "string",
    );
  }
  // Check for properties with "required": true inline marker (our own convention)
  if (schema.properties && typeof schema.properties === "object") {
    const props = schema.properties as Record<string, Record<string, unknown>>;
    return Object.entries(props)
      .filter(([, def]) => def.required === true)
      .map(([key]) => key);
  }
  return [];
}

/**
 * Detect cycles in step dependency graph using DFS.
 * Returns a list of cycle paths found.
 */
function detectCycles(steps: AgentPlanStep[]): string[][] {
  const stepMap = new Map(steps.map((s) => [s.id, s]));
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function dfs(
    nodeId: string,
    path: string[],
  ): void {
    if (visiting.has(nodeId)) {
      // Found a cycle — extract the cycle portion
      const cycleStart = path.indexOf(nodeId);
      if (cycleStart >= 0) {
        cycles.push([...path.slice(cycleStart), nodeId]);
      }
      return;
    }
    if (visited.has(nodeId)) return;

    visiting.add(nodeId);
    path.push(nodeId);

    const step = stepMap.get(nodeId);
    if (step) {
      for (const depId of step.dependsOn) {
        if (stepMap.has(depId)) {
          dfs(depId, [...path]);
        }
      }
    }

    path.pop();
    visiting.delete(nodeId);
    visited.add(nodeId);
  }

  for (const step of steps) {
    if (!visited.has(step.id)) {
      dfs(step.id, []);
    }
  }

  return cycles;
}
