import type { ToolCapability, ToolExecutionResult, ToolProvider } from "./provider.types.js";

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
