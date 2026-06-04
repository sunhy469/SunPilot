import { defineSkill } from "@sunpilot/skill-sdk";
import { z } from "zod";

const input = z.object({
  message: z.string().min(1)
});

const output = z.object({
  message: z.string(),
  echoedAt: z.string(),
  artifactId: z.string()
});

export default defineSkill({
  id: "fixture.echo-skill",
  version: "0.1.0",
  capabilities: {
    "echo.message": {
      input,
      output,
      risk: "low",
      async handler(args, ctx) {
        ctx.events.emit("skill.progress", {
          message: "Echo skill received input."
        });
        const result = {
          message: args.message,
          echoedAt: new Date().toISOString()
        };
        const artifact = await ctx.artifacts.write({
          name: "echo-result.json",
          type: "json",
          mimeType: "application/json",
          content: JSON.stringify(result, null, 2),
          metadata: { capability: "echo.message" }
        });
        await ctx.memory.write("fixture.echo.last_message", result);
        return {
          ...result,
          artifactId: artifact.id
        };
      }
    }
  }
});
