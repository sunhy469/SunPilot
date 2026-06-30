import { describe, expect, test } from "vitest";
import type { AgentContext } from "../loop-types.js";
import { ToolCatalogRetriever } from "./tool-catalog-retriever.js";
import type { SkillSummary } from "./tool-types.js";

describe("ToolCatalogRetriever", () => {
  test("uses attachment metadata when the text query is empty", async () => {
    const imageSkill = skill("image:analyze", "Analyze image files");
    const shellSkill = skill("shell:run", "Execute terminal commands");
    const result = await new ToolCatalogRetriever().retrieve({
      query: "",
      context: {
        ...context,
        currentMessage: {
          ...context.currentMessage,
          attachments: [{
            id: "attachment_1",
            name: "product-photo.png",
            type: "image/png",
          }],
        },
      },
      availableSkills: [shellSkill, imageSkill],
      permissionMode: "auto",
      limit: 1,
    });

    expect(result.tools[0]?.skill.id).toBe(imageSkill.id);
  });

  test("does not put critical tools in a degraded broad fallback", async () => {
    const critical = {
      ...skill("danger:destroy", "Destructive operation"),
      riskHints: { defaultRisk: "critical" as const },
    };
    const safe = skill("safe:read", "Read local data");
    const result = await new ToolCatalogRetriever().retrieve({
      query: "unrelated request",
      availableSkills: [critical, safe],
      permissionMode: "auto",
      limit: 2,
    });

    expect(result.fallbackUsed).toBe(true);
    expect(result.tools.map((entry) => entry.skill.id)).toEqual([safe.id]);
  });
});

function skill(id: string, description: string): SkillSummary {
  return {
    id,
    name: id,
    description,
    category: "custom",
    enabled: true,
    permissions: [],
    defaultTimeoutMs: 1_000,
    maxTimeoutMs: 2_000,
    supportsAbort: true,
    idempotent: true,
    riskHints: { defaultRisk: "low" },
  };
}

const context: AgentContext = {
  runId: "run_retrieval",
  conversationId: "conv_retrieval",
  system: { persona: "test", rules: [], safety: [] },
  currentMessage: { id: "user_retrieval", content: "", attachments: [] },
  messages: [],
  memories: [],
  artifacts: [],
  toolResults: [],
  availableSkills: [],
  limits: { maxTokens: 1_000, reservedForOutput: 100, usedTokensEstimate: 1 },
  tokenEstimate: 1,
};
