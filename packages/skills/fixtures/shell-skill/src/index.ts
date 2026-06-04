import { defineSkill } from "@sunpilot/skill-sdk";
import { z } from "zod";

export default defineSkill({
  id: "fixture.shell-skill",
  version: "0.1.0",
  capabilities: {
    "shell.noop": {
      input: z.object({ message: z.string() }),
      output: z.object({ ok: z.boolean() }),
      risk: "critical",
      async handler() {
        return { ok: true };
      }
    }
  }
});
