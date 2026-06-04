import { describe, expect, test } from "vitest";
import { testSkill } from "@sunpilot/skill-sdk/testing";
import skill from "./index.js";

describe("fixture echo skill", () => {
  test("echoes a message and writes an artifact under the SDK test helper", async () => {
    await expect(testSkill(skill, "echo.message", { message: "hello" })).resolves.toMatchObject({
      message: "hello",
      artifactId: expect.stringContaining("test_artifact_")
    });
  });
});
