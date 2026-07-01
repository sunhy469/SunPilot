import { describe, expect, test } from "vitest";
import {
  chatSendSchema,
  chatStopSchema,
  conversationSubscribeSchema,
  approvalDecideSchema,
  approvalRejectSchema,
  runCancelSchema,
  runResumeSchema,
} from "./agent-commands.js";
import { skillManifestSchema } from "./schemas.js";

describe("chatSendSchema", () => {
  test("accepts a normal text message", () => {
    const result = chatSendSchema.parse({ message: "Hello" });
    expect(result.message).toBe("Hello");
    expect(result.mode).toBe("agent");
    expect(result.permissionMode).toBe("auto");
    expect(result.attachments).toEqual([]);
  });

  test("rejects empty message with no attachments", () => {
    const result = chatSendSchema.safeParse({ message: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain(
        "either message or attachments must be provided",
      );
    }
  });

  test("rejects whitespace-only message with no attachments", () => {
    const result = chatSendSchema.safeParse({ message: "   " });
    expect(result.success).toBe(false);
  });

  test("allows empty message when attachments are present", () => {
    const result = chatSendSchema.safeParse({
      message: "",
      attachments: [{ id: "att_1", name: "file.pdf", type: "application/pdf" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.attachments).toHaveLength(1);
    }
  });

  test("allows both message and attachments", () => {
    const result = chatSendSchema.safeParse({
      message: "See attached",
      attachments: [{ id: "att_1", name: "file.pdf", type: "application/pdf" }],
    });
    expect(result.success).toBe(true);
  });

  test("defaults message to empty string when omitted", () => {
    const result = chatSendSchema.safeParse({ attachments: [] });
    // Empty message + no attachments should fail
    expect(result.success).toBe(false);
  });

  test("accepts modelId dp or seed", () => {
    expect(chatSendSchema.parse({ message: "hi", modelId: "dp" }).modelId).toBe("dp");
    expect(chatSendSchema.parse({ message: "hi", modelId: "seed" }).modelId).toBe("seed");
  });

  test("rejects invalid modelId", () => {
    const result = chatSendSchema.safeParse({ message: "hi", modelId: "claude" });
    expect(result.success).toBe(false);
  });

  test("accepts all permission modes", () => {
    for (const mode of ["ask", "auto", "full"] as const) {
      const result = chatSendSchema.safeParse({ message: "hi", permissionMode: mode });
      expect(result.success).toBe(true);
    }
  });
});

describe("chatStopSchema", () => {
  test("requires runId", () => {
    expect(chatStopSchema.safeParse({}).success).toBe(false);
    expect(chatStopSchema.safeParse({ runId: "" }).success).toBe(false);
    expect(chatStopSchema.parse({ runId: "run_1" }).runId).toBe("run_1");
  });
});

describe("conversationSubscribeSchema", () => {
  test("requires conversationId", () => {
    expect(conversationSubscribeSchema.safeParse({}).success).toBe(false);
  });

  test("defaults replayMissedEvents to true", () => {
    expect(
      conversationSubscribeSchema.parse({ conversationId: "conv_1" })
        .replayMissedEvents,
    ).toBe(true);
  });

  test("accepts lastSeenSequence", () => {
    const result = conversationSubscribeSchema.parse({
      conversationId: "conv_1",
      lastSeenSequence: 42,
      replayMissedEvents: false,
    });
    expect(result.lastSeenSequence).toBe(42);
    expect(result.replayMissedEvents).toBe(false);
  });
});

describe("approvalDecideSchema", () => {
  test("requires approvalId", () => {
    expect(approvalDecideSchema.safeParse({}).success).toBe(false);
  });

  test("defaults actor and strategy", () => {
    const result = approvalDecideSchema.parse({ approvalId: "appr_1" });
    expect(result.actor).toBe("local-user");
    expect(result.strategy).toBe("interrupt");
  });

  test("accepts all strategies", () => {
    for (const strategy of ["cancel", "interrupt", "continue_without_tool"] as const) {
      expect(
        approvalDecideSchema.safeParse({ approvalId: "appr_1", strategy }).success,
      ).toBe(true);
    }
  });
});

describe("approvalRejectSchema", () => {
  test("requires approvalId and mirrors approvalDecide defaults", () => {
    const result = approvalRejectSchema.parse({ approvalId: "appr_1" });
    expect(result.actor).toBe("local-user");
    expect(result.strategy).toBe("interrupt");
  });
});

describe("runCancelSchema", () => {
  test("requires non-empty runId", () => {
    expect(runCancelSchema.safeParse({}).success).toBe(false);
    expect(runCancelSchema.safeParse({ runId: "" }).success).toBe(false);
    expect(runCancelSchema.parse({ runId: "run_1" }).runId).toBe("run_1");
  });
});

describe("runResumeSchema", () => {
  test("accepts checkpoint input with attachments", () => {
    const result = runResumeSchema.parse({
      runId: "run_1",
      message: "  补充图片  ",
      attachments: [{
        id: "image_1",
        name: "sample.png",
        type: "image/png",
        url: "https://example.com/sample.png",
      }],
    });
    expect(result.message).toBe("补充图片");
    expect(result.attachments).toHaveLength(1);
  });

  test("rejects blank input and oversized inline attachment data", () => {
    expect(runResumeSchema.safeParse({ runId: "run_1", message: "   " }).success)
      .toBe(false);
    expect(runResumeSchema.safeParse({
      runId: "run_1",
      message: "image",
      attachments: [{
        id: "image_1",
        name: "sample.png",
        type: "image/png",
        dataUrl: "x".repeat(4 * 1024 * 1024 + 1),
      }],
    }).success).toBe(false);
  });

  test("allows attachment-only resume without a message", () => {
    const result = runResumeSchema.parse({
      runId: "run_1",
      attachments: [{
        id: "image_1",
        name: "sample.png",
        type: "image/png",
        url: "https://example.com/sample.png",
      }],
    });
    expect(result.message).toBeUndefined();
    expect(result.attachments).toHaveLength(1);
  });

  test("rejects resume with neither message nor attachments", () => {
    expect(runResumeSchema.safeParse({ runId: "run_1" }).success).toBe(false);
  });
});

describe("skillManifestSchema", () => {
  function validManifest(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: "sunpilot.skill/v1",
      id: "test.skill",
      name: "Test Skill",
      version: "1.0.0",
      description: "A test skill.",
      entry: "dist/index.js",
      readme: "README.md",
      runtime: { node: ">=22", module: "esm" },
      capabilities: [
        {
          name: "run",
          title: "Run",
          description: "Run something",
          inputSchema: {},
          outputSchema: {},
          risk: "low",
          permissions: [],
        },
      ],
      permissions: {},
      trust: "local-trusted",
      ...overrides,
    };
  }

  test("accepts a valid manifest with trust=local-trusted", () => {
    expect(skillManifestSchema.safeParse(validManifest()).success).toBe(true);
  });

  test("accepts trust=isolated", () => {
    expect(
      skillManifestSchema.safeParse(validManifest({ trust: "isolated" })).success,
    ).toBe(true);
  });

  test("defaults a legacy manifest without trust to isolated", () => {
    const { trust, ...withoutTrust } = validManifest();
    expect(skillManifestSchema.parse(withoutTrust).trust).toBe("isolated");
  });

  test("rejects invalid trust value", () => {
    expect(
      skillManifestSchema.safeParse(validManifest({ trust: "untrusted" })).success,
    ).toBe(false);
  });

  test("rejects a timeout policy whose default exceeds its maximum", () => {
    const manifest = validManifest();
    Object.assign(manifest.capabilities[0]!, { timeoutPolicy: {
      defaultMs: 10_000,
      maxMs: 5_000,
      retryable: true,
      maxRetries: 1,
      backoffMs: 100,
    } });
    expect(skillManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
