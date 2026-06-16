/**
 * MCP (Model Context Protocol) Provider — bridges external MCP servers
 * into SunPilot's Skill ecosystem (§P3-10).
 *
 * Architecture:
 *   MCP Server → listTools() → MCPTool[]
 *   MCPTool → toSkillSummary() → SkillSummary
 *   SkillSummary → ToolRetriever (mandatory funnel) → LLM receives Top-K only
 *
 * This ensures 100+ MCP tools never flood the model context — the
 * ToolRetriever filters and ranks them before they reach the LLM.
 */

import type { SkillRisk } from "@sunpilot/protocol";
import type { SkillSummary } from "../agent-kernel/tools/tool-types.js";
import type { ToolCapability, ToolExecutionResult, ToolProvider } from "./provider.types.js";

// ── MCP Tool Types ────────────────────────────────────────────────────────

/** Represents a tool discovered from an MCP server. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    tags?: string[];
  };
  /** Server identifier for multi-server MCP setups. */
  serverId: string;
  /** Server-provided timeout hint (ms). */
  timeoutHint?: number;
}

/**
 * MCP → SkillSummary adapter.
 *
 * Converts an MCP tool definition into the SkillSummary format
 * that ToolRetriever and ToolDecisionEngine understand. This is
 * the mandatory entry point for all MCP tools — nothing bypasses
 * the retrieval pipeline.
 */
export function mcpToolToSkillSummary(tool: McpTool): SkillSummary {
  return {
    id: `mcp:${tool.serverId}:${tool.name}`,
    name: tool.annotations?.title ?? tool.name,
    description: tool.description,
    category: inferMcpCategory(tool),
    enabled: true,
    permissions: inferMcpPermissions(tool),
    defaultTimeoutMs: tool.timeoutHint ?? 60_000,
    maxTimeoutMs: Math.max(tool.timeoutHint ?? 60_000, 300_000),
    supportsAbort: true,
    idempotent: tool.annotations?.idempotentHint ?? false,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    sideEffects: tool.annotations?.destructiveHint
      ? "destructive"
      : tool.annotations?.readOnlyHint
        ? "readonly"
        : "mutation",
    annotations: {
      tags: tool.annotations?.tags,
      deprecated: false,
      experimental: false,
      readOnlyHint: tool.annotations?.readOnlyHint,
      destructiveHint: tool.annotations?.destructiveHint,
      idempotentHint: tool.annotations?.idempotentHint,
    },
    timeoutPolicy: {
      defaultMs: tool.timeoutHint ?? 60_000,
      maxMs: 300_000,
      retryable: true,
      maxRetries: 2,
      backoffMs: 1000,
    },
    riskHints: {
      defaultRisk: tool.annotations?.destructiveHint ? "high" : "medium",
      destructiveArgs: tool.annotations?.destructiveHint ? ["input"] : [],
      externalHosts: [],
    },
  };
}

/**
 * Batch-convert MCP tools to SkillSummaries for ToolRetriever ingestion.
 */
export function mcpToolsToSkillSummaries(tools: McpTool[]): SkillSummary[] {
  return tools.map(mcpToolToSkillSummary);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function inferMcpCategory(tool: McpTool): SkillSummary["category"] {
  const name = tool.name.toLowerCase();
  if (/file|read|write|delete|dir|ls|cat|mkdir/i.test(name)) return "filesystem";
  if (/shell|exec|run|bash|cmd|terminal/i.test(name)) return "shell";
  if (/code|compile|lint|format|test/i.test(name)) return "code";
  if (/fetch|http|api|url|web|browser|search/i.test(name)) return "web";
  if (/memory|remember|store|recall/i.test(name)) return "memory";
  if (/artifact|generate|create|build/i.test(name)) return "artifact";
  return "custom";
}

function inferMcpPermissions(tool: McpTool): SkillSummary["permissions"] {
  const perms: SkillSummary["permissions"] = [];
  const name = tool.name.toLowerCase();
  const desc = tool.description.toLowerCase();
  const combined = `${name} ${desc}`;

  if (/read|get|list|fetch|find|search|query/i.test(combined)) {
    perms.push("filesystem.read");
  }
  if (/write|create|update|delete|remove|post|put|patch/i.test(combined)) {
    perms.push("filesystem.write");
  }
  if (/shell|exec|run|bash|terminal|cmd/i.test(combined)) {
    perms.push("shell.execute");
  }
  if (/http|api|url|web|fetch|request|download/i.test(combined)) {
    perms.push("network.request");
  }
  if (perms.length === 0) {
    perms.push("filesystem.read");
  }
  return perms;
}

// ── MCP Provider Stub (phase-one placeholder) ────────────────────────────

export class McpProviderStub implements ToolProvider {
  id = "mcp.stub";
  type = "mcp" as const;

  private tools: McpTool[] = [];

  /** Register MCP tools for use in ToolRetriever. */
  registerTools(tools: McpTool[]): void {
    this.tools = tools;
  }

  /** List capabilities as ToolCapability — ready for ToolRetriever. */
  async listCapabilities(): Promise<ToolCapability[]> {
    return this.tools.map((tool) => {
      const summary = mcpToolToSkillSummary(tool);
      return {
        providerId: this.id,
        providerType: "mcp" as const,
        capabilityName: tool.name,
        title: summary.name,
        description: summary.description,
        inputSchema: summary.inputSchema ?? {},
        outputSchema: summary.outputSchema ?? {},
        risk: summary.riskHints.defaultRisk,
        permissions: { env: { allow: [] } },
      };
    });
  }

  async execute(): Promise<ToolExecutionResult> {
    throw new Error(
      "MCP provider execution is not yet implemented — tools are available for discovery via ToolRetriever.",
    );
  }
}
