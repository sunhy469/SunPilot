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
 * ToolDecisionEngine — 决定是否使用工具以及使用哪个工具。
 *
 * 决策逻辑（架构文档 §14.3）：
 *   1. 如果有 Plan 且包含 tool 步骤 → 直接使用 Plan 中的工具调用
 *   2. 如果意图不需要工具（如 casual_chat）→ 返回 no_tool
 *   3. 匹配意图的候选技能到可用技能 → 返回 use_tool
 *   4. 仍然无匹配 → 查找 INTENT_SKILL_MAP 中的兜底技能
 *
 * 当前 MVP 阶段以规则匹配为主，后续阶段将引入 LLM 生成工具调用参数。
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
    if (!intent.requiresTool) {
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

    // Match intent candidate skills to available skills.
    // Supports both fully-qualified ids (<skill-id>:<capability>) and
    // unqualified capability names for backward compatibility.
    const matchedSkills = intent.candidateSkills
      .flatMap((candidateId) =>
        availableSkills.filter(
          (s) =>
            s.id === candidateId ||
            capabilityNameFromToolId(s.id) === candidateId ||
            s.name.toLowerCase().includes(candidateId.toLowerCase()),
        ),
      )
      .filter((s, idx, arr) => arr.findIndex((x) => x.id === s.id) === idx); // dedupe

    if (matchedSkills.length === 0) {
      // Check intent skill map for fallback
      const fallbackIds = INTENT_SKILL_MAP[intent.type] ?? [];
      const fallbackSkills = fallbackIds
        .flatMap((id) =>
          availableSkills.filter(
            (s) =>
              s.id === id ||
              capabilityNameFromToolId(s.id) === id,
          ),
        )
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

/** Extract the capability name portion from a fully-qualified tool id. */
function capabilityNameFromToolId(toolId: string): string | undefined {
  const separator = toolId.indexOf(":");
  return separator >= 0 ? toolId.slice(separator + 1) : undefined;
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
