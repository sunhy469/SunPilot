import type {
  AgentContext,
  AgentPlan,
  AgentPlanStep,
  Planner,
  RiskLevel,
  RoutedIntent,
} from "../loop-types.js";
import { INTENT_SKILL_MAP } from "../tools/tool-types.js";

export interface RuleBasedPlannerOptions {
  maxSteps?: number;
}

/**
 * Builds deterministic, auditable plans from routed intent and context.
 */
export class RuleBasedPlanner implements Planner {
  private readonly maxSteps: number;

  constructor(options: RuleBasedPlannerOptions = {}) {
    this.maxSteps = options.maxSteps ?? 20;
  }

  async createPlan(
    context: AgentContext,
    intent: RoutedIntent,
    signal: AbortSignal,
  ): Promise<AgentPlan> {
    if (signal.aborted) throw new Error("Planning aborted");

    const steps: AgentPlanStep[] = [];
    const goal = context.currentMessage.content.trim() || intent.type;
    const candidateSkillIds = candidateSkillsForIntent(intent);
    const availableSkillIds = new Set(
      context.availableSkills.map((skill) => skill.id),
    );
    const matchedSkillIds = candidateSkillIds.filter((skillId) =>
      availableSkillIds.has(skillId),
    );

    const now = new Date().toISOString();
    if (intent.requiresTool && matchedSkillIds.length > 0) {
      for (const skillId of matchedSkillIds) {
        const skill = context.availableSkills.find(
          (item) => item.id === skillId,
        );
        steps.push({
          id: `plan_step_${steps.length + 1}`,
          title: skill?.name ?? skillId,
          description: `Use ${skill?.name ?? skillId} for ${intent.type}.`,
          type: "tool",
          skillId,
          dependsOn: steps.length === 0 ? [] : [steps[steps.length - 1]!.id],
          input: {},
          expectedOutput: skill?.description,
          riskLevel: intent.riskLevel,
          status: "pending",
          updatedAt: now,
        });
      }
    }

    steps.push({
      id: `plan_step_${steps.length + 1}`,
      title: "Reason about results",
      description:
        steps.length > 0
          ? "Inspect tool observations and decide what to tell the user."
          : "Reason from the available conversation context.",
      type: "reasoning",
      dependsOn: steps.length === 0 ? [] : [steps[steps.length - 1]!.id],
      riskLevel: "low",
      status: "pending",
      updatedAt: now,
    });

    steps.push({
      id: `plan_step_${steps.length + 1}`,
      title: "Compose response",
      description: "Return a concise user-facing response.",
      type: "response",
      dependsOn: [steps[steps.length - 1]!.id],
      riskLevel: "low",
      status: "pending",
      updatedAt: now,
    });

    const finalSteps = steps.slice(0, this.maxSteps);
    return {
      id: `plan_${crypto.randomUUID()}`,
      runId: context.runId,
      goal,
      summary: summarizePlan(intent, matchedSkillIds),
      riskLevel: maxRisk(intent.riskLevel, maxStepRisk(finalSteps)),
      steps: finalSteps,
      expectedArtifacts: expectedArtifactsForIntent(intent),
      requiresApproval:
        intent.requiresApproval ||
        finalSteps.some(
          (step) => step.riskLevel === "high" || step.riskLevel === "critical",
        ),
    };
  }
}

function candidateSkillsForIntent(intent: RoutedIntent): string[] {
  const mapped = INTENT_SKILL_MAP[intent.type] ?? [];
  return [...new Set([...intent.candidateSkills, ...mapped])];
}

function summarizePlan(intent: RoutedIntent, skillIds: string[]): string {
  if (skillIds.length === 0) {
    return `Handle ${intent.type} using context and a final response.`;
  }
  return `Handle ${intent.type} with ${skillIds.length} tool step(s), reasoning, and a final response.`;
}

function expectedArtifactsForIntent(
  intent: RoutedIntent,
): AgentPlan["expectedArtifacts"] {
  if (intent.type !== "artifact_generation") return [];
  return [
    {
      id: `expected_artifact_${crypto.randomUUID()}`,
      type: "document",
      title: "Generated document",
      description: "Document or report requested by the user.",
    },
  ];
}

function maxStepRisk(steps: AgentPlanStep[]): RiskLevel {
  return steps.reduce<RiskLevel>(
    (current, step) => maxRisk(current, step.riskLevel),
    "low",
  );
}

function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  const order: Record<RiskLevel, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return order[left] >= order[right] ? left : right;
}
