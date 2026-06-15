import type {
  AgentContext,
  PermissionPolicy as PermissionPolicyInterface,
  PermissionMode,
} from '../loop-types.js';
import {
  classifyRisk,
  type Permission,
  type PermissionDecision,
} from './safety-types.js';

/**
 * PermissionPolicy — 权限策略引擎，评估工具调用是否允许/需审批/应拒绝。
 *
 * 策略矩阵（架构文档 §15.4），按用户选择的 permissionMode 调整：
 *
 *   ask  (保守): low → auto-allow, medium+ → require approval, critical → reject
 *   auto (平衡): low → auto-allow, medium → auto-allow if explicit perms,
 *                high → require approval, critical → reject
 *   full (完全): low/medium/high → auto-allow, critical → reject
 *
 * 风险等级由 classifyRisk 根据 skillId 类别和参数内容判定，
 * 同时参考 skill manifest 提供的 riskHints (destructiveArgs, externalHosts)。
 */
export class PermissionPolicy implements PermissionPolicyInterface {
  async evaluate(input: {
    userId?: string;
    runId: string;
    skillId: string;
    permissions: Permission[];
    arguments: Record<string, unknown>;
    context: AgentContext;
    /** User-selected permission mode from the frontend. */
    permissionMode?: PermissionMode;
    /** Optional capability-level risk hints from the skill manifest. */
    riskHints?: {
      defaultRisk?: "low" | "medium" | "high" | "critical";
      destructiveArgs?: string[];
      externalHosts?: string[];
    };
  }): Promise<PermissionDecision> {
    const { skillId, permissions, arguments: args, riskHints } = input;
    const mode = input.permissionMode ?? "auto";

    // Determine category from skillId
    const category = this.categoryFromSkillId(skillId);

    // Classify risk — use manifest riskHints.defaultRisk if stricter
    const baseClassification = classifyRisk(category, args);
    const riskLevel =
      riskHints?.defaultRisk &&
      riskOrder(riskHints.defaultRisk) > riskOrder(baseClassification.riskLevel)
        ? riskHints.defaultRisk
        : baseClassification.riskLevel;
    const reasons = [
      ...baseClassification.reasons,
      ...(riskHints?.destructiveArgs?.length
        ? [`Destructive arguments: ${riskHints.destructiveArgs.join(", ")}`]
        : []),
      ...(riskHints?.externalHosts?.length
        ? [`External hosts: ${riskHints.externalHosts.join(", ")}`]
        : []),
      `Permission mode: ${mode}`,
    ];

    // Critical risk → always reject regardless of mode
    if (riskLevel === 'critical') {
      return {
        allowed: false,
        requiresApproval: false,
        riskLevel: 'critical',
        reasons: [...reasons, 'Critical risk actions are rejected by default'],
      };
    }

    // ── Mode-specific decision logic ──────────────────────────────

    switch (mode) {
      case 'full':
        // Full access: auto-allow low/medium/high, only reject critical
        if (riskLevel === 'high') {
          return {
            allowed: true,
            requiresApproval: false,
            riskLevel: 'high',
            reasons: [...reasons, 'Full permission mode auto-allows high risk'],
          };
        }
        return {
          allowed: true,
          requiresApproval: false,
          riskLevel,
          reasons: [...reasons, 'Full permission mode — auto-allowed'],
        };

      case 'ask':
        // Conservative: require approval for medium+ risk
        if (riskLevel === 'high') {
          return {
            allowed: true,
            requiresApproval: true,
            riskLevel: 'high',
            reasons: [...reasons, 'Ask mode requires approval for high risk'],
          };
        }
        if (riskLevel === 'medium') {
          return {
            allowed: true,
            requiresApproval: true,
            riskLevel: 'medium',
            reasons: [...reasons, 'Ask mode requires approval for medium+ risk'],
          };
        }
        // Low risk → auto allow
        return {
          allowed: true,
          requiresApproval: false,
          riskLevel: 'low',
          reasons: [...reasons, 'Ask mode auto-allows low risk'],
        };

      case 'auto':
      default:
        // Balanced (default): risk-based with approval for high risk
        if (riskLevel === 'high') {
          return {
            allowed: true,
            requiresApproval: true,
            riskLevel: 'high',
            reasons: [...reasons, 'Auto mode requires approval for high risk'],
          };
        }
        if (riskLevel === 'medium') {
          if (permissions.length > 0) {
            return {
              allowed: true,
              requiresApproval: false,
              riskLevel: 'medium',
              reasons: [...reasons, 'Auto mode: medium risk with explicit permissions'],
            };
          }
          return {
            allowed: true,
            requiresApproval: true,
            riskLevel: 'medium',
            reasons: [...reasons, 'Auto mode: medium risk without explicit permissions requires approval'],
          };
        }
        return {
          allowed: true,
          requiresApproval: false,
          riskLevel: 'low',
          reasons: [...reasons, 'Auto mode auto-allows low risk'],
        };
    }
  }

  private categoryFromSkillId(skillId: string): string {
    // Extract capability name for fully-qualified ids (<skill-id>:<capability>)
    const capability = skillId.includes(':')
      ? skillId.slice(skillId.lastIndexOf(':') + 1)
      : skillId;
    if (capability.startsWith('filesystem')) return 'filesystem';
    if (capability.startsWith('shell')) return 'shell';
    if (capability.startsWith('network') || capability.startsWith('web'))
      return 'network';
    if (capability.startsWith('database') || capability.startsWith('db'))
      return 'database';
    if (capability.startsWith('memory')) return 'memory';
    if (capability.startsWith('artifact')) return 'artifact';
    return 'custom';
  }
}

function riskOrder(level: string): number {
  const order: Record<string, number> = {
    low: 0, medium: 1, high: 2, critical: 3,
  };
  return order[level] ?? 0;
}
