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
 * PermissionPolicy — evaluates whether a tool call is allowed,
 * requires approval, or should be rejected outright.
 *
 * Implements the policy matrix from architecture doc §15.4:
 *   low       → auto allow
 *   medium    → allow if inside workspace, otherwise approval
 *   high      → approval required
 *   critical  → reject by default
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
    if (skillId.startsWith('filesystem')) return 'filesystem';
    if (skillId.startsWith('shell')) return 'shell';
    if (skillId.startsWith('network') || skillId.startsWith('web'))
      return 'network';
    if (skillId.startsWith('database') || skillId.startsWith('db'))
      return 'database';
    if (skillId.startsWith('memory')) return 'memory';
    if (skillId.startsWith('artifact')) return 'artifact';
    return 'custom';
  }
}
