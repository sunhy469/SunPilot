import type { StepRecord } from "@sunpilot/protocol";
import type { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";
import type { ToolCapability, ToolExecutionRequest, ToolExecutionResult, ToolProvider } from "./provider.types.js";

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
