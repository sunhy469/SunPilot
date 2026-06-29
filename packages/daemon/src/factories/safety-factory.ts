/**
 * Safety factory — wires the unified execution safety boundary: permission
 * policy, approval gate, prompt injection detector, tool sandbox, and
 * task-scoped permission manager.
 *
 * Extracted from composition-root.ts (Batch 4 §3).
 */
import type { DatabaseContext } from "@sunpilot/storage";
import {
  PermissionPolicy,
  PromptInjectionDetector,
  RepositoryApprovalDecisionService,
  RepositoryApprovalGate,
  RepositoryApprovalRequestService,
  TaskScopedPermissionManager,
  ToolSandbox,
  ToolSafetyBoundary,
  type AgentEventBus,
  type SandboxMode,
} from "@sunpilot/core";

export interface SafetyFactoryDeps {
  database: DatabaseContext;
  rawEventBus: AgentEventBus;
  sandboxMode: SandboxMode;
}

export interface SafetyFactoryResult {
  permissionPolicy: PermissionPolicy;
  approvalGate: RepositoryApprovalGate;
  approvalDecisionService: RepositoryApprovalDecisionService;
  approvalRequestService: RepositoryApprovalRequestService;
  injectionDetector: PromptInjectionDetector;
  toolSandbox: ToolSandbox;
  scopedPermissionManager: TaskScopedPermissionManager;
  toolSafetyBoundary: ToolSafetyBoundary;
}

export function createSafetyLayer(
  deps: SafetyFactoryDeps,
): SafetyFactoryResult {
  const permissionPolicy = new PermissionPolicy();
  const approvalGate = new RepositoryApprovalGate(deps.database);
  const approvalDecisionService = new RepositoryApprovalDecisionService(
    deps.database,
  );
  const approvalRequestService = new RepositoryApprovalRequestService(
    deps.database,
  );

  // The three controls are owned by the common execution boundary. This
  // makes native calls, approval resumes, and direct orchestrator calls share
  // the same checks before execution and before results enter model context.
  const injectionDetector = new PromptInjectionDetector({
    blockCritical: true,
    warnOnMatch: true,
  });
  const toolSandbox = new ToolSandbox(deps.sandboxMode);
  console.log(`[sandbox] Mode: ${deps.sandboxMode}`);
  const scopedPermissionManager = new TaskScopedPermissionManager();
  const toolSafetyBoundary = new ToolSafetyBoundary({
    eventBus: deps.rawEventBus,
    sandbox: toolSandbox,
    permissionManager: scopedPermissionManager,
    injectionDetector,
  });

  return {
    permissionPolicy,
    approvalGate,
    approvalDecisionService,
    approvalRequestService,
    injectionDetector,
    toolSandbox,
    scopedPermissionManager,
    toolSafetyBoundary,
  };
}
