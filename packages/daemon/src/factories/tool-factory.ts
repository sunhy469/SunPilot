/**
 * Tool factory — wires the capability catalog and deterministic execution
 * boundary. Semantic action selection belongs exclusively to ReactLoopRunner.
 *
 * Extracted from composition-root.ts (Batch 4 §3).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StepRecord } from "@sunpilot/protocol";
import type { DatabaseContext } from "@sunpilot/storage";
import type { SkillRegistry, SkillRunner } from "@sunpilot/skill-runner";
import {
  ExecutionOrchestrator,
  SkillToolExecutor,
  type AgentEventBus,
  type Permission,
  type ToolSafetyBoundary,
  type SkillSummary,
} from "@sunpilot/core";

export interface ToolFactoryDeps {
  database: DatabaseContext;
  rawEventBus: AgentEventBus;
  skillRegistry: SkillRegistry;
  skillRunner?: SkillRunner;
  toolSafetyBoundary: ToolSafetyBoundary;
}

export interface ToolFactoryResult {
  listSkillSummaries: () => Promise<SkillSummary[]>;
  skillExecutor: SkillToolExecutor;
  executionOrchestrator: ExecutionOrchestrator;
}

export function createToolLayer(deps: ToolFactoryDeps): ToolFactoryResult {
  const {
    database,
    rawEventBus,
    skillRegistry,
    skillRunner,
    toolSafetyBoundary,
  } = deps;

  // §Bugfix: Load JSON schema from file path when inputSchema is a string
  const loadSchema = (
    schema: string | Record<string, unknown> | undefined,
    skillPath: string,
  ): Record<string, unknown> | undefined => {
    if (typeof schema === "object" && schema !== null) return schema as Record<string, unknown>;
    if (typeof schema !== "string") return undefined;
    try {
      const filePath = join(skillPath, schema);
      if (existsSync(filePath)) {
        return JSON.parse(readFileSync(filePath, "utf-8"));
      }
    } catch { /* Best effort */ }
    return undefined;
  };

  // Shared helper — builds SkillSummary[] from skill registry (§refactor)
  const listSkillSummaries: ToolFactoryResult["listSkillSummaries"] = async () => {
    const skills = skillRegistry.list();
    return skills.flatMap((s) =>
      s.manifest.capabilities.map((capability) => {
        const permissions = normalizeCapabilityPermissions(capability.permissions);
        return {
          id: capabilityToolId(s.id, capability.name),
          name: capability.title,
          description: capability.description,
          category: categoryFromCapability(capability.name),
          enabled: s.enabled,
          trust: s.manifest.trust,
          permissions,
          defaultTimeoutMs: 60_000,
          maxTimeoutMs: 300_000,
          supportsAbort: true,
          idempotent: false,
          inputSchema: loadSchema(capability.inputSchema, s.path),
          outputSchema: loadSchema(capability.outputSchema, s.path),
          sideEffects: classifySideEffects(permissions),
          riskHints: {
            defaultRisk: capability.risk as
              | "low"
              | "medium"
              | "high"
              | "critical",
          },
        };
      }),
    );
  };

  // ── Execution ──────────────────────────────────────────────────
  // Skill executor: delegates to SkillToolExecutor in core.
  const skillExecutor = new SkillToolExecutor({
    listSkills: () => skillRegistry.list(),
    runSkill: async (step) => {
      if (!skillRunner) {
        throw new Error(
          "SkillRunner is not configured for Agent tool execution.",
        );
      }
      return skillRunner.execute(step);
    },
    createStep: async (step) => {
      await database.steps.create({
        id: step.id,
        runId: step.runId,
        type: step.type as "skill" | "approval" | "builtin" | "manual",
        name: step.name,
        status: step.status as StepRecord["status"],
        skillId: step.skillId,
        input: step.input ?? {},
      });
    },
    updateStepStatus: (id, status, output, error) =>
      database.steps.updateStatus(id, status, output, error),
    listArtifacts: async (runId) => database.artifacts.list(runId),
  });

  const executionOrchestrator = new ExecutionOrchestrator({
    toolExecutor: skillExecutor,
    eventBus: rawEventBus,
    toolCalls: database.toolCalls,
    safetyBoundary: toolSafetyBoundary,
  });

  return {
    listSkillSummaries,
    skillExecutor,
    executionOrchestrator,
  };
}

// ── Helper functions ──────────────────────────────────────────────

function capabilityToolId(skillId: string, capabilityName: string): string {
  return `${skillId}:${capabilityName}`;
}

function categoryFromCapability(
  capability: string,
):
  | "filesystem"
  | "shell"
  | "code"
  | "web"
  | "memory"
  | "artifact"
  | "automation"
  | "custom" {
  if (capability.startsWith("filesystem")) return "filesystem";
  if (capability.startsWith("shell")) return "shell";
  if (capability.startsWith("web") || capability.startsWith("network"))
    return "web";
  if (capability.startsWith("memory")) return "memory";
  if (capability.startsWith("artifact")) return "artifact";
  if (capability.startsWith("automation")) return "automation";
  if (capability.startsWith("code")) return "code";
  return "custom";
}

function normalizeCapabilityPermissions(permissions: string[]): Permission[] {
  const normalized = permissions.flatMap((permission) => {
    switch (permission) {
      case "filesystem":
        return ["filesystem.read", "filesystem.write"] as Permission[];
      case "filesystem.read":
      case "filesystem.write":
      case "filesystem.delete":
      case "shell.execute":
      case "network.request":
      case "database.read":
      case "database.write":
      case "secret.read":
      case "artifact.write":
      case "memory.write":
      case "external.send":
        return [permission] as Permission[];
      case "shell":
        return ["shell.execute"] as Permission[];
      case "network":
      case "web":
        return ["network.request"] as Permission[];
      case "database":
      case "db":
        return ["database.read", "database.write"] as Permission[];
      case "env":
      case "secret":
        return ["secret.read"] as Permission[];
      case "artifact":
        return ["artifact.write"] as Permission[];
      case "memory":
        return ["memory.write"] as Permission[];
      default:
        return [];
    }
  });
  return [...new Set(normalized)];
}

/**
 * Classify side-effects from permissions heuristic (§P2).
 * Exact classification should come from the manifest when the
 * schema is extended. This heuristic provides useful signal for
 * routing (e.g., reducing destructive-tool false positives).
 */
function classifySideEffects(
  permissions: string[],
): "none" | "readonly" | "mutation" | "network" | "destructive" {
  if (permissions.includes("shell.execute")) return "destructive";
  if (permissions.includes("filesystem.write") || permissions.includes("filesystem.delete")) return "mutation";
  if (permissions.includes("network.request") || permissions.includes("external.send")) return "network";
  if (permissions.includes("database.write")) return "mutation";
  if (permissions.includes("filesystem.read") || permissions.includes("database.read") || permissions.includes("secret.read")) return "readonly";
  if (permissions.includes("artifact.write")) return "mutation";
  if (permissions.includes("memory.write")) return "mutation";
  return "none";
}
