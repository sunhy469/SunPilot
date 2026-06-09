import type { WorkflowRecord } from "@sunpilot/protocol";

/**
 * 将 WorkflowRecord 转换为 ToolDecisionEngine 可消费的工具描述。
 * workflow.* skillId 在 ToolDecisionEngine 中被视为一类工具能力。
 */
export interface WorkflowToolDescriptor {
  id: string;
  name: string;
  description: string;
  category: "workflow";
  enabled: boolean;
  permissions: string[];
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  supportsAbort: boolean;
  idempotent: boolean;
  riskHints: {
    defaultRisk: "low" | "medium" | "high" | "critical";
  };
}

export function workflowToToolDescriptor(
  workflow: WorkflowRecord,
): WorkflowToolDescriptor {
  const description = extractDescription(workflow.definition);
  return {
    id: `workflow.${workflow.id}`,
    name: workflow.title,
    description,
    category: "workflow",
    enabled: workflow.enabled,
    permissions: [],
    defaultTimeoutMs: 60_000,
    maxTimeoutMs: 300_000,
    supportsAbort: false,
    idempotent: false,
    riskHints: { defaultRisk: "medium" },
  };
}

function extractDescription(definition: unknown): string {
  if (definition && typeof definition === "object") {
    const desc = (definition as { description?: unknown }).description;
    if (typeof desc === "string" && desc.trim()) {
      return desc;
    }
  }
  return "Run a structured workflow.";
}
