/**
 * Tests for ToolArgumentBuilder image alias filling and dataUrl support.
 *
 * §Phase 0 of agent_dialog_streaming_bugfix_and_path_unification.md
 */

import { describe, expect, test } from "vitest";
import { DefaultToolArgumentBuilder } from "./tool-argument-builder.js";
import type { AgentContext, AttachmentRef } from "../loop-types.js";
import type { SkillSummary } from "./tool-types.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeContext(
  overrides: Partial<AgentContext> = {},
): AgentContext {
  return {
    runId: "run_test",
    conversationId: "conv_test",
    system: { persona: "test", rules: [], safety: [] },
    currentMessage: {
      id: "msg_1",
      content: "帮我搜索这件衣服的同款货源",
      attachments: [],
    },
    messages: [],
    memories: [],
    artifacts: [],
    toolResults: [],
    availableSkills: [],
    limits: {
      maxTokens: 8000,
      reservedForOutput: 1000,
      usedTokensEstimate: 10,
    },
    tokenEstimate: 10,
    ...overrides,
  };
}

const searchSkill: SkillSummary = {
  id: "jaderoad:product.source.search1688",
  name: "搜索 1688 货源",
  description: "Search 1688 by product image or text query.",
  category: "custom",
  enabled: true,
  permissions: ["network.request"],
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 10_000,
  supportsAbort: true,
  idempotent: true,
  riskHints: { defaultRisk: "medium" },
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      imageUrl: { type: "string" },
      imageDataUrl: { type: "string" },
    },
    anyOf: [
      { required: ["imageUrl"] },
      { required: ["imageDataUrl"] },
    ],
  },
};

function makeImageAttachment(overrides: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    id: "att_img_1",
    name: "product.jpg",
    type: "image/jpeg",
    url: "https://example.com/product.jpg",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("DefaultToolArgumentBuilder image alias filling", () => {
  test("fills imageUrl and image_url from attachment url", async () => {
    const builder = new DefaultToolArgumentBuilder();
    const ctx = makeContext({
      currentMessage: {
        id: "msg_1",
        content: "搜索同款",
        attachments: [makeImageAttachment({ url: "https://example.com/img.jpg" })],
      },
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    expect(result.arguments.imageUrl).toBe("https://example.com/img.jpg");
    expect(result.arguments.image_url).toBe("https://example.com/img.jpg");
    // url convenience alias should also be set
    expect(result.arguments.url).toBe("https://example.com/img.jpg");
    // Should include imageUrl in sources
    expect(result.sources.some((s) => s.arg === "imageUrl")).toBe(true);
    // §P0: anyOf(imageUrl|imageDataUrl) satisfied by imageUrl → no missing fields
    expect(result.missing).toEqual([]);
  });

  test("fills imageDataUrl and image_data_url from attachment dataUrl fallback", async () => {
    const builder = new DefaultToolArgumentBuilder();
    const dataUrl = "data:image/jpeg;base64,/9j/4AAQ...";
    const ctx = makeContext({
      currentMessage: {
        id: "msg_1",
        content: "搜索同款",
        attachments: [
          makeImageAttachment({
            url: undefined,
            dataUrl,
          }),
        ],
      },
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    expect(result.arguments.imageDataUrl).toBe(dataUrl);
    expect(result.arguments.image_data_url).toBe(dataUrl);
    // imageUrl should NOT be set when there's no URL
    expect(result.arguments.imageUrl).toBeUndefined();
    // imageDataUrl should appear in sources
    expect(result.sources.some((s) => s.arg === "imageDataUrl")).toBe(true);
    // §P0: anyOf(imageUrl|imageDataUrl) satisfied by imageDataUrl → no missing fields
    expect(result.missing).toEqual([]);
  });

  test("fills both imageUrl and imageDataUrl when attachment has both", async () => {
    const builder = new DefaultToolArgumentBuilder();
    const ctx = makeContext({
      currentMessage: {
        id: "msg_1",
        content: "搜索同款",
        attachments: [
          makeImageAttachment({
            url: "https://example.com/img.jpg",
            dataUrl: "data:image/jpeg;base64,/9j/4AAQ...",
          }),
        ],
      },
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    expect(result.arguments.imageUrl).toBe("https://example.com/img.jpg");
    expect(result.arguments.image_url).toBe("https://example.com/img.jpg");
    expect(result.arguments.imageDataUrl).toBe("data:image/jpeg;base64,/9j/4AAQ...");
    expect(result.arguments.image_data_url).toBe("data:image/jpeg;base64,/9j/4AAQ...");
    // §P0: both branches satisfied → no missing fields
    expect(result.missing).toEqual([]);
  });

  test("prefers attachment with URL over attachment with only dataUrl", async () => {
    const builder = new DefaultToolArgumentBuilder();
    const ctx = makeContext({
      currentMessage: {
        id: "msg_1",
        content: "搜索同款",
        attachments: [
          {
            id: "att_no_url",
            name: "no-url.jpg",
            type: "image/jpeg",
            dataUrl: "data:image/jpeg;base64,/9j/4AAQ...",
            url: undefined,
          },
          {
            id: "att_with_url",
            name: "with-url.jpg",
            type: "image/jpeg",
            url: "https://example.com/real-image.jpg",
          },
        ],
      },
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    // Should prefer the attachment WITH a URL over the dataUrl-only one
    expect(result.arguments.imageUrl).toBe("https://example.com/real-image.jpg");
    // The source ref should point to the URL attachment
    const imageUrlSource = result.sources.find((s) => s.arg === "imageUrl");
    expect(imageUrlSource?.ref).toBe("att_with_url");
    // §P0: anyOf satisfied by URL attachment → no missing fields
    expect(result.missing).toEqual([]);
  });

  test("reports empty missing for anyOf schema when neither branch is satisfiable", async () => {
    // §P0: When neither imageUrl nor imageDataUrl can be filled, the builder
    // correctly returns missing=[] (no universally-required fields), but
    // executeToolCalls should use checkAnyOfUnsatisfied() to detect this
    // case and emit an error part instead of calling the skill.
    const builder = new DefaultToolArgumentBuilder();
    const ctx = makeContext({
      currentMessage: {
        id: "msg_1",
        content: "搜索同款",
        // No attachments at all — neither imageUrl nor imageDataUrl can be filled
        attachments: [],
      },
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    // No universally-required fields (each is optional via anyOf)
    expect(result.missing).toEqual([]);
    // Both image fields are absent — but that's expected here since
    // checkAnyOfUnsatisfied handles the disjunction check separately
    expect(result.arguments.imageUrl).toBeUndefined();
    expect(result.arguments.imageDataUrl).toBeUndefined();
  });

  test("detects image attachment by name extension when type is missing", async () => {
    const builder = new DefaultToolArgumentBuilder();
    const ctx = makeContext({
      currentMessage: {
        id: "msg_1",
        content: "搜索同款",
        attachments: [
          {
            id: "att_no_type",
            name: "screenshot.png",
            type: "application/octet-stream",
            url: "https://example.com/screenshot.png",
          },
        ],
      },
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    // Should still detect as image via .png extension
    expect(result.arguments.imageUrl).toBe("https://example.com/screenshot.png");
  });

  test("includes dataUrl in serialized attachments array", async () => {
    const builder = new DefaultToolArgumentBuilder();
    const dataUrl = "data:image/png;base64,iVBORw0KGgo...";
    const ctx = makeContext({
      currentMessage: {
        id: "msg_1",
        content: "搜索同款",
        attachments: [
          {
            id: "att_1",
            name: "photo.png",
            type: "image/png",
            url: "https://example.com/photo.png",
            dataUrl,
            storageKey: "uploads/photo.png",
            provider: "aliyun-oss",
          },
        ],
      },
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    const serializedAttachments = result.arguments.attachments as Array<Record<string, unknown>>;
    expect(serializedAttachments).toHaveLength(1);
    expect(serializedAttachments[0]!.dataUrl).toBe(dataUrl);
    expect(serializedAttachments[0]!.url).toBe("https://example.com/photo.png");
    expect(serializedAttachments[0]!.provider).toBe("aliyun-oss");
  });

  test("does not set imageUrl from non-image attachments", async () => {
    const builder = new DefaultToolArgumentBuilder();
    const ctx = makeContext({
      currentMessage: {
        id: "msg_1",
        content: "分析这个文件",
        attachments: [
          {
            id: "att_pdf",
            name: "report.pdf",
            type: "application/pdf",
            url: "https://example.com/report.pdf",
          },
        ],
      },
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    // PDF is not an image — imageUrl should NOT be set
    expect(result.arguments.imageUrl).toBeUndefined();
  });

  test("fills imageDataUrl from historical attachment stored in context messages", async () => {
    // §5.2: When the current message has no attachment, but a historical
    // message in the same conversation had an image with dataUrl, the builder
    // should recover it from context.messages[].metadata.attachments.
    const builder = new DefaultToolArgumentBuilder();
    const historicalDataUrl = "data:image/jpeg;base64,/9j/4AAQS...";
    const ctx = makeContext({
      currentMessage: {
        id: "msg_current",
        content: "用这张旧图搜索同款货源",
        // No attachments on current message — simulating a retry/resume scenario
        attachments: [],
      },
      messages: [
        {
          role: "user",
          content: "帮我搜同款",
          metadata: {
            attachments: [
              {
                id: "att_hist",
                name: "old-photo.jpg",
                type: "image/jpeg",
                dataUrl: historicalDataUrl,
              },
            ],
          },
        },
      ],
    });

    const result = await builder.build(
      {
        context: ctx,
        intent: {
          type: "use_skill",
          confidence: 0.9,
          requiresPlanning: false,
          requiresTool: true,
          requiresApproval: false,
          riskLevel: "low",
          candidateSkills: [searchSkill.id],
          reason: "test",
        },
        skill: searchSkill,
        schema: searchSkill.inputSchema,
      },
      new AbortController().signal,
    );

    expect(result.arguments.imageDataUrl).toBe(historicalDataUrl);
    expect(result.sources.some((s) => s.arg === "imageDataUrl")).toBe(true);
    // §P0: anyOf satisfied by historical dataUrl → no missing fields
    expect(result.missing).toEqual([]);
  });
});
