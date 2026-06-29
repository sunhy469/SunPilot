import { describe, expect, test } from "vitest";
import { ObservationBuilder } from "./observation-builder.js";

describe("ObservationBuilder", () => {
  test.each(["failed", "timeout", "cancelled"] as const)(
    "maps %s tool results to failed observations",
    (status) => {
      const result = new ObservationBuilder(1_000).fromToolSummary({
        id: "call_1",
        skillId: "test:tool",
        name: "Tool",
        status,
        summary: "not completed",
      });
      expect(result.kind).toBe("tool_failed");
      expect(result.modelContent).toContain(status.toUpperCase());
    },
  );

  test("uses structured output and truncates model content", () => {
    const result = new ObservationBuilder(20).fromToolSummary({
      id: "call_1",
      skillId: "test:tool",
      name: "Tool",
      status: "completed",
      summary: "short",
      structured: { value: "x".repeat(100) },
    });
    expect(result.kind).toBe("tool_completed");
    expect(result.structured).toEqual({ value: "x".repeat(100) });
    expect(result.modelContent).toContain("truncated");
  });

  test("merges artifacts by stable id", () => {
    const builder = new ObservationBuilder(100);
    expect(builder.mergeArtifacts(
      [{ id: "a", name: "old", type: "file" }],
      [{ id: "a", name: "new", type: "file" }, { id: "b", name: "b", type: "image" }],
    )).toEqual([
      { id: "a", name: "new", type: "file" },
      { id: "b", name: "b", type: "image" },
    ]);
  });
});
