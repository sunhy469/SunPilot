import { describe, expect, test } from "vitest";
import { McpProviderStub, mcpToolToSkillSummary } from "./providers.js";
import type { McpTool } from "./providers.js";

describe("McpProviderStub", () => {
  test("returns empty capabilities by default and rejects execution", async () => {
    const provider = new McpProviderStub();
    await expect(provider.listCapabilities()).resolves.toEqual([]);
    await expect(
      provider.execute({
        runId: "run_1",
        stepId: "step_1",
        providerId: "mcp.stub",
        capabilityName: "noop",
        input: {},
      }),
    ).rejects.toThrow("MCP provider execution is not yet implemented");
  });

  test("registers and converts MCP tools to capabilities", async () => {
    const provider = new McpProviderStub();
    const tools: McpTool[] = [
      {
        name: "web_search",
        description: "Search the web",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
        serverId: "test-server",
        annotations: { title: "Web Search", readOnlyHint: true },
      },
    ];
    provider.registerTools(tools);
    const capabilities = await provider.listCapabilities();
    expect(capabilities).toHaveLength(1);
    expect(capabilities[0]!.capabilityName).toBe("web_search");
    expect(capabilities[0]!.title).toBe("Web Search");
    expect(capabilities[0]!.providerId).toBe("mcp.stub");
    expect(capabilities[0]!.providerType).toBe("mcp");
  });

  test("mcpToolToSkillSummary converts with correct metadata", () => {
    const tool: McpTool = {
      name: "filesystem.read",
      description: "Read a file from disk",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      serverId: "local",
      annotations: {
        title: "Read File",
        readOnlyHint: true,
        idempotentHint: true,
        tags: ["fs", "read"],
      },
    };
    const summary = mcpToolToSkillSummary(tool);
    expect(summary.id).toBe("mcp:local:filesystem.read");
    expect(summary.name).toBe("Read File");
    expect(summary.category).toBe("filesystem");
    expect(summary.sideEffects).toBe("readonly");
    expect(summary.idempotent).toBe(true);
    expect(summary.annotations?.tags).toContain("fs");
  });
});
