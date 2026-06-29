/**
 * Task-Scoped Permission Manager (§5 of architecture next steps).
 *
 * Enhances the existing permission system with:
 * - Permissions scoped to the current run or plan step
 * - User approval of one tool ≠ approval of all similar tools
 * - High-risk tool re-confirmation requirements
 * - Parameter-change risk re-evaluation
 * - Approval record binding to tool call ID, plan step ID, and parameter summary
 *
 * This builds on top of the existing PermissionPolicy and ApprovalGate,
 * adding finer-grained controls for production safety.
 */

import type { Permission, RiskLevel } from "../loop-types.js";

// ── Task-Scoped Types ────────────────────────────────────────────────────

export interface TaskScopedPermission {
  /** The permission being granted. */
  permission: Permission;
  /** The specific run this permission applies to. */
  runId: string;
  /** The specific plan step this permission applies to (if any). */
  planStepId?: string;
  /** The specific tool call this permission applies to. */
  toolCallId?: string;
  /** The specific skill being authorized. */
  skillId: string;
  /** The exact arguments that were approved. */
  approvedArgs: Record<string, unknown>;
  /** When this permission was granted. */
  grantedAt: string;
  /** When this permission expires. */
  expiresAt: string;
  /** Who granted this permission. */
  grantedBy: string;
  /** Risk level at time of granting. */
  riskLevel: RiskLevel;
  /** Scope of this permission. */
  scope: TaskPermissionScope;
}

export type TaskPermissionScope =
  | "this_tool_call_only"       // Most restrictive
  | "this_plan_step"            // Within current plan step
  | "this_run"                  // Entire current run
  | "this_conversation";        // Whole conversation

export interface TaskPermissionCheck {
  /** The permission being requested. */
  requestedPermission: Permission;
  /** Current run ID. */
  runId: string;
  /** Current plan step ID. */
  planStepId?: string;
  /** Current tool call ID. */
  toolCallId?: string;
  /** Skill being used. */
  skillId: string;
  /** Arguments for the tool call. */
  arguments: Record<string, unknown>;
  /** Previously granted permissions in this run. */
  existingGrants: TaskScopedPermission[];
  /** Current permission mode. */
  permissionMode: "ask" | "auto" | "full";
  /** Risk level after argument-aware classification. */
  riskLevel: RiskLevel;
}

export interface TaskPermissionDecision {
  /** Whether the permission is granted. */
  granted: boolean;
  /** Whether re-approval is needed (even if a similar permission was granted). */
  needsReapproval: boolean;
  /** Reason for the decision. */
  reason: string;
  /** The granted permission (if granted). */
  grant?: TaskScopedPermission;
}

// ── Permission scope rules ───────────────────────────────────────────────

/**
 * Rules for when re-approval is required, even if a similar permission
 * was previously granted:
 *
 * 1. Different tool/skill → re-approval needed
 * 2. Same skill but different parameters → re-approval needed
 * 3. Same skill, same params, but risk level changed → re-approval needed
 * 4. Same skill, same params, but previous grant expired → re-approval needed
 * 5. High/critical risk → always re-approve per execution
 * 6. Same skill, same safe params, within same run → use existing grant
 */

/**
 * TaskScopedPermissionManager — enforces fine-grained permission boundaries.
 */
export class TaskScopedPermissionManager {
  /**
   * Check if a requested permission should be granted based on
   * existing grants and task scope rules.
   */
  check(params: TaskPermissionCheck): TaskPermissionDecision {
    const {
      requestedPermission,
      runId,
      planStepId,
      toolCallId,
      skillId,
      arguments: args,
      existingGrants,
      permissionMode,
      riskLevel,
    } = params;

    // Full mode: always grant
    if (permissionMode === "full") {
      return {
        granted: true,
        needsReapproval: false,
        reason: "Full permission mode — all operations allowed",
        grant: createGrant(params, "this_run", riskLevel),
      };
    }

    // Filter grants relevant to this run
    const runGrants = existingGrants.filter((g) => g.runId === runId);
    const sameSkillGrants = runGrants.filter((g) => g.skillId === skillId);
    const samePermissionGrants = sameSkillGrants.filter(
      (g) => g.permission === requestedPermission,
    );

    // No previous grant → needs approval (unless auto mode and low risk)
    if (samePermissionGrants.length === 0) {
      if (permissionMode === "auto" || riskLevel === "low") {
        return {
          granted: true,
          needsReapproval: false,
          reason:
            permissionMode === "auto"
              ? "Auto permission mode — granting first-time use"
              : "Low-risk permission — granting this tool call",
          grant: createGrant(
            params,
            permissionMode === "auto" ? "this_run" : "this_tool_call_only",
            riskLevel,
          ),
        };
      }
      return {
        granted: false,
        needsReapproval: true,
        reason: `No existing grant for ${requestedPermission} on ${skillId}`,
      };
    }

    // Check each existing grant for validity
    const validGrant = samePermissionGrants.find((grant) => {
      // 1. Same args? If args differ significantly, re-approval needed
      if (!argsMatch(grant.approvedArgs, args)) {
        return false;
      }

      // A changed risk classification invalidates the old grant even when
      // the serialized arguments happen to be identical.
      if (grant.riskLevel !== riskLevel) {
        return false;
      }

      // 2. Not expired?
      if (new Date(grant.expiresAt) < new Date()) {
        return false;
      }

      // 3. Scope is sufficient?
      if (grant.scope === "this_tool_call_only" && grant.toolCallId !== toolCallId) {
        return false;
      }
      if (grant.scope === "this_plan_step" && grant.planStepId !== planStepId) {
        return false;
      }

      return true;
    });

    if (validGrant) {
      return {
        granted: true,
        needsReapproval: false,
        reason: `Existing grant (${validGrant.scope}) covers this request`,
        grant: validGrant,
      };
    }

    // Existing grants exist but aren't valid for this specific request
    // → needs re-approval
    return {
      granted: false,
      needsReapproval: true,
      reason: "Existing grants don't cover this specific operation — parameters or scope differ",
    };
  }

  /** Create a grant bound to the exact user-approved tool call and arguments. */
  createApprovedGrant(
    params: TaskPermissionCheck,
    grantedBy: string,
  ): TaskScopedPermission {
    return createGrant(
      params,
      "this_tool_call_only",
      params.riskLevel,
      grantedBy,
    );
  }

  /**
   * Determine if high-risk operations should always require fresh approval,
   * even within the same run.
   */
  requiresFreshApproval(skillId: string, riskLevel: RiskLevel): boolean {
    // Critical risk: ALWAYS re-approve
    if (riskLevel === "critical") return true;

    // High risk: re-approve per execution
    if (riskLevel === "high") return true;

    // Destructive operations: always re-approve
    const destructivePatterns = [
      "filesystem.delete",
      "filesystem.write",
      "shell.execute",
      "external.send",
    ];
    if (destructivePatterns.some((p) => skillId.includes(p))) {
      return riskLevel !== "low";
    }

    return false;
  }

  /**
   * Check if argument changes should trigger re-approval.
   *
   * Re-approval triggers:
   * - Different target path
   * - Different domain
   * - Elevated risk in new parameters
   */
  shouldReapproveForArgs(
    originalArgs: Record<string, unknown>,
    newArgs: Record<string, unknown>,
  ): boolean {
    // Different file paths → re-approve
    const origPath = originalArgs["path"] ?? originalArgs["target"] ?? originalArgs["file"];
    const newPath = newArgs["path"] ?? newArgs["target"] ?? newArgs["file"];
    if (origPath !== undefined && newPath !== undefined && origPath !== newPath) {
      return true;
    }

    // Different domains → re-approve
    const origDomain = originalArgs["url"] ?? originalArgs["domain"] ?? originalArgs["host"];
    const newDomain = newArgs["url"] ?? newArgs["domain"] ?? newArgs["host"];
    if (origDomain !== undefined && newDomain !== undefined && origDomain !== newDomain) {
      return true;
    }

    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function createGrant(
  params: TaskPermissionCheck,
  scope: TaskPermissionScope,
  riskLevel?: RiskLevel,
  grantedBy = "agent",
): TaskScopedPermission {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 min default

  return {
    permission: params.requestedPermission,
    runId: params.runId,
    planStepId: params.planStepId,
    toolCallId: params.toolCallId,
    skillId: params.skillId,
    approvedArgs: { ...params.arguments },
    grantedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    grantedBy,
    riskLevel: riskLevel ?? "medium",
    scope,
  };
}

/**
 * Compare two argument sets for meaningful differences.
 * Returns true if the args are considered equivalent.
 */
function argsMatch(
  approved: Record<string, unknown>,
  requested: Record<string, unknown>,
): boolean {
  const approvedKeys = Object.keys(approved).sort();
  const requestedKeys = Object.keys(requested).sort();

  // Different keys → mismatch
  if (approvedKeys.length !== requestedKeys.length) return false;
  if (!approvedKeys.every((k, i) => k === requestedKeys[i])) return false;

  // Compare values (shallow)
  for (const key of approvedKeys) {
    const aVal = JSON.stringify(approved[key]);
    const rVal = JSON.stringify(requested[key]);
    if (aVal !== rVal) return false;
  }

  return true;
}
