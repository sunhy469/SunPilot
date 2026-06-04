import { describe, expect, test } from "vitest";
import { z } from "zod";
import { defineSkill } from "./index.js";
import { testSkill } from "./testing.js";

describe("testSkill", () => {
  test("provides artifact, file, and secret helpers for unit tests", async () => {
    const skill = defineSkill({
      id: "test.sdk",
      version: "0.1.0",
      capabilities: {
        "test.helpers": {
          input: z.object({ path: z.string(), secretName: z.string() }),
          output: z.object({ artifactId: z.string(), fileContent: z.string(), secret: z.string().optional() }),
          risk: "low",
          async handler(input, context) {
            await context.files.writeText(input.path, "hello");
            const artifact = await context.artifacts.write({ name: "result.txt", type: "text", content: "artifact" });
            return {
              artifactId: artifact.id,
              fileContent: await context.files.readText(input.path),
              secret: await context.secrets.get(input.secretName)
            };
          }
        }
      }
    });

    await expect(testSkill(skill, "test.helpers", { path: "/tmp/test.txt", secretName: "API_KEY" }, { secrets: { API_KEY: "secret" } })).resolves.toMatchObject({
      artifactId: expect.stringContaining("test_artifact_"),
      fileContent: "hello",
      secret: "secret"
    });
  });
});
