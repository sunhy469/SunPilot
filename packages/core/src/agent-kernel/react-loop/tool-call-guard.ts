import type { ToolCall } from "../../llm/llm.types.js";
import type {
  AgentContext,
  PermissionMode,
  PermissionPolicy,
  PlannedToolCall,
} from "../loop-types.js";
import type { SkillSummary } from "../tools/tool-types.js";
import { validateToolArguments } from "../tools/tool-argument-validator.js";
import type { ReactObservation } from "./react-types.js";
import { ObservationBuilder } from "./observation-builder.js";

export interface GuardedToolBatch {
  executable: PlannedToolCall[];
  approvalRequired: PlannedToolCall[];
  observations: ReactObservation[];
}

export class ToolCallGuard {
  constructor(
    private readonly permissionPolicy: PermissionPolicy,
    private readonly observations: ObservationBuilder,
  ) {}

  async check(input: {
    runId: string;
    context: AgentContext;
    calls: ToolCall[];
    toolNameMap: Map<string, string>;
    availableSkills: SkillSummary[];
    permissionMode: PermissionMode;
    seenSignatures: Map<string, number>;
    maxRepeatedToolCalls: number;
  }): Promise<GuardedToolBatch> {
    const executable: PlannedToolCall[] = [];
    const approvalRequired: PlannedToolCall[] = [];
    const observations: ReactObservation[] = [];
    const acceptedSignatures = new Map<string, string>();
    const seenCallIds = new Set<string>();

    for (const call of input.calls) {
      if (!call.id.trim() || seenCallIds.has(call.id)) {
        observations.push(
          this.observations.validationFailure({
            call,
            message: call.id.trim()
              ? `Duplicate tool_call_id '${call.id}' in the same model turn`
              : "Tool call is missing a tool_call_id",
          }),
        );
        continue;
      }
      seenCallIds.add(call.id);
      const skillId = input.toolNameMap.get(call.function.name);
      const skill = skillId
        ? input.availableSkills.find((candidate) => candidate.id === skillId)
        : undefined;

      if (!skillId || !skill) {
        observations.push(
          this.observations.validationFailure({
            call,
            message: `Unknown or unavailable tool '${call.function.name}'`,
            details: { availableToolNames: [...input.toolNameMap.keys()] },
          }),
        );
        continue;
      }

      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(call.function.arguments);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("arguments must be a JSON object");
        }
        args = parsed as Record<string, unknown>;
      } catch (error) {
        observations.push(
          this.observations.validationFailure({
            call,
            skillId,
            message: error instanceof Error ? error.message : "invalid JSON arguments",
          }),
        );
        continue;
      }

      const validationErrors = validateToolArguments(args, skill.inputSchema);
      if (validationErrors.length > 0) {
        observations.push(
          this.observations.validationFailure({
            call,
            skillId,
            message: validationErrors.join("; "),
            details: { arguments: args, schema: skill.inputSchema },
          }),
        );
        continue;
      }

      const signature = `${skillId}:${stableStringify(args)}`;
      if (
        (input.seenSignatures.get(signature) ?? 0) >=
        input.maxRepeatedToolCalls
      ) {
        observations.push(this.observations.duplicate({ call, skillId }));
        continue;
      }
      input.seenSignatures.set(
        signature,
        (input.seenSignatures.get(signature) ?? 0) + 1,
      );
      acceptedSignatures.set(call.id, signature);

      const permission = await this.permissionPolicy.evaluate({
        userId: input.context.userId,
        runId: input.runId,
        skillId,
        permissions: skill.permissions,
        arguments: args,
        context: input.context,
        permissionMode: input.permissionMode,
        riskHints: skill.riskHints,
      });

      if (!permission.allowed) {
        observations.push(
          this.observations.permissionDenied({
            call,
            skillId,
            reasons: permission.reasons,
          }),
        );
        continue;
      }

      const riskLevel = permission.riskLevel ?? skill.riskHints.defaultRisk;
      const planned: PlannedToolCall = {
        id: call.id,
        skillId,
        name: skill.name,
        arguments: args,
        permissions: skill.permissions,
        reason: "LLM native function call",
        riskLevel,
        // PermissionPolicy is the single owner of approval semantics. In
        // particular, full mode intentionally permits high-risk actions;
        // re-deriving the decision here would contradict that policy.
        requiresApproval: permission.requiresApproval,
        timeoutMs: Math.min(skill.defaultTimeoutMs, skill.maxTimeoutMs),
        riskHints: skill.riskHints,
        inputSchema: skill.inputSchema,
        projectionHints: skill.projectionHints,
        argumentSources: Object.keys(args).map((arg) => ({
          arg,
          source: "llm" as const,
        })),
        metadata: {
          outputTrust:
            skill.trust === "isolated" ||
            skill.permissions.includes("network.request") ||
            skill.sideEffects === "network"
              ? "untrusted"
              : "trusted",
        },
      };

      if (planned.requiresApproval) approvalRequired.push(planned);
      else executable.push(planned);
    }

    // Approval is an atomic batch boundary. If any validated call requires
    // approval, freeze every validated call and execute none.
    if (observations.length > 0 && (executable.length > 0 || approvalRequired.length > 0)) {
      for (const call of [...executable, ...approvalRequired]) {
        const signature = acceptedSignatures.get(call.id);
        if (signature) decrementSignature(input.seenSignatures, signature);
        observations.push(
          this.observations.validationFailure({
            call: {
              id: call.id,
              type: "function",
              function: {
                name: [...input.toolNameMap.entries()].find(([, id]) => id === call.skillId)?.[0] ?? call.skillId,
                arguments: JSON.stringify(call.arguments),
              },
            },
            skillId: call.skillId,
            message: "The tool batch was not executed because another call in the same batch was invalid",
          }),
        );
      }
      executable.length = 0;
      approvalRequired.length = 0;
    }

    if (approvalRequired.length > 0) {
      approvalRequired.unshift(...executable.splice(0));
    }

    return { executable, approvalRequired, observations };
  }
}

function decrementSignature(counts: Map<string, number>, signature: string): void {
  const count = counts.get(signature) ?? 0;
  if (count <= 1) counts.delete(signature);
  else counts.set(signature, count - 1);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
