import type {
  AgentContext,
  AgentPlan,
  RoutedIntent,
  ToolDecision,
  ToolDecisionEngine as ToolDecisionEngineInterface,
} from "../loop-types.js";
import { INTENT_SKILL_MAP, type SkillSummary } from "./tool-types.js";

export interface ToolDecisionEngineDeps {
  /** List all available skills with their summaries. */
  listSkills: () => Promise<SkillSummary[]>;
}

/**
 * ToolDecisionEngine — decides whether and which tools to use.
 *
 * Decision logic (per architecture doc §14.3):
 *   1. Read available skills
 *   2. Filter disabled / no-permission skills
 *   3. Match intent → candidate skills
 *   4. Return ToolDecision
 *
 * In the MVP, this is primarily rule-based. Phase 5 will add
 * LLM-based tool call argument generation.
 */
export class ToolDecisionEngine implements ToolDecisionEngineInterface {
  constructor(private readonly deps: ToolDecisionEngineDeps) {}

  async decide(
    input: {
      context: AgentContext;
      intent: RoutedIntent;
      plan?: AgentPlan;
    },
    _signal: AbortSignal,
  ): Promise<ToolDecision> {
    const { context, intent, plan } = input;

    // If plan has tool steps, use those
    if (plan && plan.steps.some((s) => s.type === "tool" && s.skillId)) {
      const availableSkills = await this.listEnabledSkills();
      const toolSteps = plan.steps.filter(
        (s) => s.type === "tool" && s.skillId,
      );
      return {
        type: "use_tool",
        toolCalls: toolSteps.map((step) => {
          const skill = availableSkills.find(
            (item) => item.id === step.skillId,
          );
          const riskLevel = maxRisk(
            step.riskLevel,
            skill?.riskHints.defaultRisk ?? "low",
          );
          return {
            id: `tc_${crypto.randomUUID()}`,
            skillId: step.skillId!,
            name: step.title,
            arguments: step.input ?? {},
            permissions: skill?.permissions ?? [],
            reason: `Plan step: ${step.description}`,
            riskLevel,
            requiresApproval: riskLevel === "high" || riskLevel === "critical",
            timeoutMs: skill
              ? Math.min(skill.defaultTimeoutMs, skill.maxTimeoutMs)
              : 60_000,
          };
        }),
        reason: `Executing ${toolSteps.length} tool step(s) from plan`,
      };
    }

    // No tool needed for these intent types
    if (!intent.requiresTool || intent.candidateSkills.length === 0) {
      return {
        type: "no_tool",
        reason: `Intent '${intent.type}' doesn't require tools`,
      };
    }

    // Get available skills
    let availableSkills: SkillSummary[] = [];
    try {
      availableSkills = await this.listEnabledSkills();
    } catch {
      // Skill catalog unavailable — fall back to no_tool
      return {
        type: "no_tool",
        reason: "Skill catalog unavailable",
      };
    }

    // Match intent candidate skills to available skills
    const matchedSkills = intent.candidateSkills
      .flatMap((candidateId) =>
        availableSkills.filter(
          (s) =>
            s.id === candidateId ||
            s.name.toLowerCase().includes(candidateId.toLowerCase()),
        ),
      )
      .filter((s, idx, arr) => arr.findIndex((x) => x.id === s.id) === idx); // dedupe

    if (matchedSkills.length === 0) {
      if (intent.type === "workflow_execution") {
        const workflowSkills = availableSkills.filter(
          (skill) => skill.category === "workflow",
        );
        const message = context.currentMessage.content.toLowerCase();
        const namedWorkflowSkills = workflowSkills.filter(
          (skill) =>
            message.includes(skill.id.toLowerCase()) ||
            message.includes(skill.name.toLowerCase()),
        );
        const selectedWorkflowSkills =
          namedWorkflowSkills.length > 0
            ? namedWorkflowSkills
            : workflowSkills.length === 1
              ? workflowSkills
              : [];
        if (selectedWorkflowSkills.length > 0) {
          return {
            type: "use_tool",
            toolCalls: selectedWorkflowSkills.map((skill) => ({
              id: `tc_${crypto.randomUUID()}`,
              skillId: skill.id,
              name: skill.name,
              arguments: { message: context.currentMessage.content },
              permissions: skill.permissions,
              reason: `Matched workflow for intent '${intent.type}'`,
              riskLevel: skill.riskHints.defaultRisk,
              requiresApproval:
                skill.riskHints.defaultRisk === "high" ||
                skill.riskHints.defaultRisk === "critical",
              timeoutMs: Math.min(skill.defaultTimeoutMs, skill.maxTimeoutMs),
            })),
            reason: `Matched ${selectedWorkflowSkills.length} workflow(s) for intent '${intent.type}'`,
          };
        }
      }

      // Check intent skill map for fallback
      const fallbackIds = INTENT_SKILL_MAP[intent.type] ?? [];
      const fallbackSkills = fallbackIds
        .flatMap((id) => availableSkills.filter((s) => s.id === id))
        .filter((s, idx, arr) => arr.findIndex((x) => x.id === s.id) === idx);

      if (fallbackSkills.length === 0) {
        return {
          type: "no_tool",
          reason: `No available skills matched intent '${intent.type}'`,
        };
      }

      return {
        type: "use_tool",
        toolCalls: fallbackSkills.map((skill) => ({
          id: `tc_${crypto.randomUUID()}`,
          skillId: skill.id,
          name: skill.name,
          arguments: {},
          permissions: skill.permissions,
          reason: `Fallback match for intent '${intent.type}'`,
          riskLevel: skill.riskHints.defaultRisk,
          requiresApproval:
            skill.riskHints.defaultRisk === "high" ||
            skill.riskHints.defaultRisk === "critical",
          timeoutMs: Math.min(skill.defaultTimeoutMs, skill.maxTimeoutMs),
        })),
        reason: `Matched ${fallbackSkills.length} fallback skill(s) for intent '${intent.type}'`,
      };
    }

    return {
      type: "use_tool",
      toolCalls: matchedSkills.map((skill) => ({
        id: `tc_${crypto.randomUUID()}`,
        skillId: skill.id,
        name: skill.name,
        arguments: {},
        permissions: skill.permissions,
        reason: `Matched for intent '${intent.type}'`,
        riskLevel: skill.riskHints.defaultRisk,
        requiresApproval:
          skill.riskHints.defaultRisk === "high" ||
          skill.riskHints.defaultRisk === "critical",
        timeoutMs: Math.min(skill.defaultTimeoutMs, skill.maxTimeoutMs),
      })),
      reason: `Matched ${matchedSkills.length} skill(s) for intent '${intent.type}'`,
    };
  }

  private async listEnabledSkills(): Promise<SkillSummary[]> {
    const allSkills = await this.deps.listSkills();
    return allSkills.filter((skill) => skill.enabled);
  }
}

function maxRisk(
  left: "low" | "medium" | "high" | "critical",
  right: "low" | "medium" | "high" | "critical",
): "low" | "medium" | "high" | "critical" {
  const order = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3,
  };
  return order[left] >= order[right] ? left : right;
}
