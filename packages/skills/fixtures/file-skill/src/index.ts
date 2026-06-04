import { defineSkill } from "@sunpilot/skill-sdk";
import { z } from "zod";

export default defineSkill({
  id: "fixture.file-skill",
  version: "0.1.0",
  capabilities: {
    "files.writeOutside": {
      input: z.object({ path: z.string(), content: z.string() }),
      output: z.object({ ok: z.boolean() }),
      risk: "high",
      async handler(args, ctx) {
        await ctx.files.writeText(args.path, args.content);
        return { ok: true };
      }
    }
  }
});
