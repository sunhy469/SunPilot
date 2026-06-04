import type { PermissionDeclaration, SkillRisk, StepRecord } from "@sunpilot/protocol";
import type { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";

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

export class McpProviderStub implements ToolProvider {
  id = "mcp.stub";
  type = "mcp" as const;

  async listCapabilities(): Promise<ToolCapability[]> {
    return [];
  }

  async execute(): Promise<ToolExecutionResult> {
    throw new Error("MCP provider is a phase-one stub.");
  }
}

export class SkillProvider implements ToolProvider {
  id = "skill";
  type = "skill" as const;

  constructor(
    private readonly registry: SkillRegistry,
    private readonly runner: SkillRunner
  ) {}

  async listCapabilities(): Promise<ToolCapability[]> {
    return this.registry.list().flatMap((skill) =>
      skill.manifest.capabilities.map((capability) => ({
        providerId: skill.id,
        providerType: "skill" as const,
        capabilityName: capability.name,
        title: capability.title,
        description: capability.description,
        inputSchema: capability.inputSchema,
        outputSchema: capability.outputSchema,
        risk: capability.risk,
        permissions: skill.manifest.permissions
      }))
    );
  }

  async execute(request: ToolExecutionRequest): Promise<ToolExecutionResult> {
    const step: StepRecord = {
      id: request.stepId,
      runId: request.runId,
      type: "skill",
      name: request.capabilityName,
      status: "running",
      skillId: request.providerId,
      capability: request.capabilityName,
      input: request.input
    };
    return { output: await this.runner.execute(step) };
  }

  interrupt(runId: string): void {
    this.runner.interruptRun(runId);
  }
}
