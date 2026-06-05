import type { PermissionDeclaration, SkillRisk } from "@sunpilot/protocol";

export interface ToolCapability {
  providerId: string;
  providerType: "skill" | "mcp" | "builtin";
  capabilityName: string;
  title: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  risk: SkillRisk;
  permissions: PermissionDeclaration;
}

export interface ToolExecutionRequest {
  runId: string;
  stepId: string;
  providerId: string;
  capabilityName: string;
  input: unknown;
}

export interface ToolExecutionResult {
  output: unknown;
}

export interface ToolProvider {
  id: string;
  type: "skill" | "mcp" | "builtin";
  listCapabilities(): Promise<ToolCapability[]>;
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
  interrupt?(runId: string): void;
}
