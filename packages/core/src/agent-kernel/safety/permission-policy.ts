import type {
  AgentContext,
  PermissionPolicy as PermissionPolicyInterface,
} from '../loop-types.js';
import {
  classifyRisk,
  type Permission,
  type PermissionDecision,
} from './safety-types.js';

/**
 * PermissionPolicy — 权限策略引擎，评估工具调用是否允许/需审批/应拒绝。
 *
 * 策略矩阵（架构文档 §15.4）：
 *   low       → 自动允许，无需审批
 *   medium    → 有显式权限声明则允许，否则需审批
 *   high      → 必须审批
 *   critical  → 默认拒绝
 *
 * 风险等级由 classifyRisk 根据 skillId 类别和参数内容判定：
 * - filesystem.write → high
 * - shell.execute → high
 * - network.request → medium
 * - filesystem.read → low
 */
export class PermissionPolicy implements PermissionPolicyInterface {
  async evaluate(input: {
    userId?: string;
    runId: string;
    skillId: string;
    permissions: Permission[];
    arguments: Record<string, unknown>;
    context: AgentContext;
  }): Promise<PermissionDecision> {
    const { skillId, permissions, arguments: args } = input;

    // Determine category from skillId
    const category = this.categoryFromSkillId(skillId);

    // Classify risk
    const { riskLevel, reasons } = classifyRisk(category, args);

    // Critical risk → reject by default
    if (riskLevel === 'critical') {
      return {
        allowed: false,
        requiresApproval: false,
        riskLevel: 'critical',
        reasons: [...reasons, 'Critical risk actions are rejected by default'],
      };
    }

    // High risk → require approval
    if (riskLevel === 'high') {
      return {
        allowed: true,
        requiresApproval: true,
        riskLevel: 'high',
        reasons: [...reasons, 'High risk actions require approval'],
      };
    }

    // Medium risk → allow if we have explicit permissions
    if (riskLevel === 'medium') {
      if (permissions.length > 0) {
        return {
          allowed: true,
          requiresApproval: false,
          riskLevel: 'medium',
          reasons: [...reasons, 'Medium risk with explicit permission set'],
        };
      }
      return {
        allowed: true,
        requiresApproval: true,
        riskLevel: 'medium',
        reasons: [...reasons, 'Medium risk without explicit permissions requires approval'],
      };
    }

    // Low risk → auto allow
    return {
      allowed: true,
      requiresApproval: false,
      riskLevel: 'low',
      reasons: [...reasons, 'Low risk actions are auto-allowed'],
    };
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
