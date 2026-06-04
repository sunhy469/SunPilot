import { describe, expect, test } from "vitest";
import { McpProviderStub } from "./providers.js";

describe("McpProviderStub", () => {
  test("lists no capabilities in phase one and rejects execution", async () => {
    const provider = new McpProviderStub();
    await expect(provider.listCapabilities()).resolves.toEqual([]);
    await expect(
      provider.execute({
        runId: "run_1",
        stepId: "step_1",
        providerId: "mcp.stub",
        capabilityName: "noop",
        input: {}
      })
    ).rejects.toThrow("MCP provider is a phase-one stub.");
  });
});
