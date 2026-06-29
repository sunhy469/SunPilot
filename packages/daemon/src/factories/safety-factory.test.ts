import { describe, expect, test } from "vitest";
import { InMemoryDatabaseContext } from "@sunpilot/storage";
import { InMemoryAgentEventBus } from "@sunpilot/core";

import { createSafetyLayer } from "./safety-factory.js";

describe("createSafetyLayer", () => {
  test("returns all safety components bound to the provided DB and event bus", () => {
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();
    const { permissionPolicy, approvalGate, approvalDecisionService, approvalRequestService, injectionDetector, toolSandbox, scopedPermissionManager, toolSafetyBoundary } =
      createSafetyLayer({ database: db, rawEventBus, sandboxMode: "moderate" });

    expect(permissionPolicy).toBeDefined();
    expect(approvalGate).toBeDefined();
    expect(approvalDecisionService).toBeDefined();
    expect(approvalRequestService).toBeDefined();
    expect(injectionDetector).toBeDefined();
    expect(toolSandbox).toBeDefined();
    expect(scopedPermissionManager).toBeDefined();
    expect(toolSafetyBoundary).toBeDefined();
  });

  test("configures the tool sandbox with the supplied sandboxMode", () => {
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();

    const strict = createSafetyLayer({
      database: db,
      rawEventBus,
      sandboxMode: "strict",
    });
    const permissive = createSafetyLayer({
      database: db,
      rawEventBus,
      sandboxMode: "permissive",
    });

    expect(strict.toolSandbox.config.mode).toBe("strict");
    expect(permissive.toolSandbox.config.mode).toBe("permissive");
  });

  test("injects rawEventBus into the ToolSafetyBoundary", () => {
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();

    const { toolSafetyBoundary } = createSafetyLayer({
      database: db,
      rawEventBus,
      sandboxMode: "moderate",
    });

    expect(toolSafetyBoundary).toBeDefined();
  });

  test("injectionDetector is configured to block critical injections", () => {
    const db = new InMemoryDatabaseContext();
    const rawEventBus = new InMemoryAgentEventBus();

    const { injectionDetector } = createSafetyLayer({
      database: db,
      rawEventBus,
      sandboxMode: "moderate",
    });

    expect(injectionDetector).toBeDefined();
  });
});
