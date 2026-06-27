import { describe, expect, test } from "vitest";
import { MemoryCompressor } from "./memory-compressor.js";

function makeMem(id: string, content: string, overrides: Partial<{
  type: string;
  title: string;
  confidence: number;
  importance: number;
  createdAt: string;
}> = {}) {
  return {
    id,
    type: overrides.type ?? "user_preference",
    title: overrides.title ?? `Memory ${id}`,
    content,
    confidence: overrides.confidence ?? 0.8,
    importance: overrides.importance ?? 0.6,
    createdAt: overrides.createdAt ?? "2026-06-25T00:00:00.000Z",
  };
}

describe("MemoryCompressor", () => {
  test("passes through short content unchanged (below maxChars)", () => {
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 800 });
    const mem = makeMem("1", "Short memory content.");
    const result = compressor.compress([mem]);
    expect(result).toHaveLength(1);
    expect(result[0]!.compressed).toBe(false);
    expect(result[0]!.memory.content).toBe("Short memory content.");
    expect(result[0]!.originalLength).toBe(21);
    expect(result[0]!.compressedLength).toBe(21);
  });

  test("passes through content exactly at maxChars", () => {
    const content = "A".repeat(100);
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 100 });
    const result = compressor.compress([makeMem("1", content)]);
    expect(result[0]!.compressed).toBe(false);
    expect(result[0]!.memory.content).toBe(content);
  });

  test("compresses long content using first-N-sentence extraction", () => {
    // Use sentences long enough that first two together exceed 100 chars
    // (avoids the fallback at compressed.length < 100)
    const s1 = "The deployment pipeline configuration requires careful setup of environment variables and secure credential management for production servers.";
    const s2 = "Additionally, the monitoring stack must integrate with existing alerting infrastructure to ensure timely notification of service disruptions.";
    const s3 = "Further considerations include database migration strategies and rollback procedures for failed deployments.";
    const content = `${s1} ${s2} ${s3}`;
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 200 });
    const result = compressor.compress([makeMem("1", content)]);
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(200);
    // Should contain at least the first sentence
    expect(result[0]!.memory.content).toContain("deployment pipeline configuration");
    expect(result[0]!.memory.content).toContain("production servers");
  });

  test("falls back to first-sentence truncation when extraction yields very little", () => {
    // One extremely long "sentence" where extraction fails to get any complete sentence
    const content = "A" + " very".repeat(200) + " long content without proper sentence boundaries in the beginning";
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 50 });
    const result = compressor.compress([makeMem("1", content)]);
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(50);
    // Should not be empty
    expect(result[0]!.memory.content.length).toBeGreaterThan(0);
  });

  test("pure truncation as last resort when no sentences extracted", () => {
    const content = "abcdefghijklmnopqrstuvwxyz".repeat(10);
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 20 });
    const result = compressor.compress([makeMem("1", content)]);
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(20);
  });

  test("handles empty content", () => {
    const compressor = new MemoryCompressor();
    const result = compressor.compress([makeMem("1", "")]);
    expect(result[0]!.compressed).toBe(false);
    expect(result[0]!.originalLength).toBe(0);
    expect(result[0]!.compressedLength).toBe(0);
  });

  test("handles multiple memories in batch", () => {
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 100 });
    const short = makeMem("s", "Short.");
    const long = makeMem("l", "This is a much longer piece of content. ".repeat(20));
    const result = compressor.compress([short, long]);
    expect(result).toHaveLength(2);
    expect(result[0]!.compressed).toBe(false);
    expect(result[1]!.compressed).toBe(true);
  });

  test("preserves metadata fields through compression", () => {
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 20 });
    const mem = makeMem("1", "This is much too long for the budget.", {
      type: "error_solution",
      title: "Fix for issue #42",
      confidence: 0.95,
      importance: 0.9,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const result = compressor.compress([mem]);
    expect(result[0]!.memory.id).toBe("1");
    expect(result[0]!.memory.type).toBe("error_solution");
    expect(result[0]!.memory.title).toBe("Fix for issue #42");
    expect(result[0]!.memory.confidence).toBe(0.95);
    expect(result[0]!.memory.importance).toBe(0.9);
    expect(result[0]!.memory.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("handles Unicode and CJK characters correctly", () => {
    const shortChinese = "用户偏好：简洁的中文回答。";
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 200 });
    const result = compressor.compress([makeMem("1", shortChinese)]);
    expect(result[0]!.compressed).toBe(false);
    expect(result[0]!.memory.content).toBe(shortChinese);
  });

  test("extracts sentences across Chinese punctuation", () => {
    const content = "这是第一句话。这是第二句话！这是第三句话？这是第四句话。".repeat(10);
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 50 });
    const result = compressor.compress([makeMem("1", content)]);
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(50);
  });

  test("handles content with only newlines as separators", () => {
    const content = "Line one\nLine two\nLine three\nLine four";
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 25 });
    const result = compressor.compress([makeMem("1", content)]);
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(25);
  });

  test("handles single very long word (no spaces)", () => {
    const content = "SupercalifragilisticexpialidociousRepeat".repeat(5);
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 30 });
    const result = compressor.compress([makeMem("1", content)]);
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(30);
  });

  test("uses default 800 chars when no maxCharsPerMemory specified", () => {
    const compressor = new MemoryCompressor();
    const content = "Short enough. ".repeat(30); // ~390 chars, well under 800
    const result = compressor.compress([makeMem("1", content)]);
    expect(result[0]!.compressed).toBe(false);
  });
});

// ── LLM Summarization tests (compressAsync) ────────────────────────

describe("MemoryCompressor — LLM summarization (compressAsync)", () => {
  const longContent =
    "The deployment pipeline requires careful configuration of environment variables, " +
    "secrets management, database migration strategies, monitoring setup, alerting rules, " +
    "load balancer configuration, auto-scaling policies, network security groups, " +
    "SSL certificate provisioning, DNS updates, health check endpoints, log aggregation, " +
    "distributed tracing, and rollback procedures. Each component must be coordinated " +
    "to ensure zero-downtime deployments and quick recovery from failures.";

  test("uses LLM summary when callback provided and content is long enough", async () => {
    const summarize = async (content: string, maxChars: number) => {
      return "LLM summary: deploy pipeline with env vars, secrets, DB migration, monitoring, and rollback.";
    };
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 200,
      summarize,
      summarizeMinChars: 100,
    });

    const result = await compressor.compressAsync([makeMem("1", longContent)]);

    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.llmSummarized).toBe(true);
    expect(result[0]!.memory.content).toContain("LLM summary");
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(200);
    expect(result[0]!.originalLength).toBeGreaterThan(200);
  });

  test("falls back to sentence extraction when no summarize callback", async () => {
    const compressor = new MemoryCompressor({ maxCharsPerMemory: 200 });
    const result = await compressor.compressAsync([makeMem("1", longContent)]);
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.llmSummarized).toBeUndefined();
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(200);
  });

  test("falls back to sentence extraction when content below summarizeMinChars", async () => {
    const summarize = async () => "should not be called";
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 20,
      summarize,
      summarizeMinChars: 9999, // Very high threshold
    });
    const content = "This is a short piece of content that needs compression.";
    const result = await compressor.compressAsync([makeMem("1", content)]);
    // Should use sentence extraction, not LLM (content < 9999 chars)
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.llmSummarized).toBeUndefined();
  });

  test("falls back to sentence extraction when LLM summarization throws", async () => {
    const summarize = async () => {
      throw new Error("LLM unavailable");
    };
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 200,
      summarize,
      summarizeMinChars: 100,
    });

    const result = await compressor.compressAsync([makeMem("1", longContent)]);

    // Should still compress, just without LLM
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.llmSummarized).toBeUndefined();
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(200);
  });

  test("falls back to sentence extraction when LLM returns empty string", async () => {
    const summarize = async () => "";
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 200,
      summarize,
      summarizeMinChars: 100,
    });

    const result = await compressor.compressAsync([makeMem("1", longContent)]);

    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.llmSummarized).toBeUndefined();
  });

  test("trims LLM summary if it still exceeds maxChars", async () => {
    const summarize = async () => {
      // Return a summary that's still too long
      return "A".repeat(300);
    };
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 200,
      summarize,
      summarizeMinChars: 100,
    });

    const result = await compressor.compressAsync([makeMem("1", longContent)]);

    // Should use the summary but trim it, still marked as llmSummarized
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.llmSummarized).toBe(true);
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(200);
    expect(result[0]!.originalLength).toBeGreaterThan(200);
  });

  test("falls back to original content extraction when trimmed LLM summary is not shorter", async () => {
    // Edge case: summary is longer than original content somehow
    const content = "Short but over budget. ".repeat(10);
    const summarize = async () => content + " extra padding that makes it even longer than before";
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 50,
      summarize,
      summarizeMinChars: 10,
    });

    const result = await compressor.compressAsync([makeMem("1", content)]);

    // Should fall back to sentence extraction on the original content
    // since the (trimmed) summary is not shorter than original
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.compressedLength).toBeLessThanOrEqual(50);
  });

  test("handles multiple memories in async batch with mixed summarization", async () => {
    const summarize = async (content: string) => {
      if (content.includes("deployment")) {
        return "Summarized deployment content.";
      }
      throw new Error("LLM fail for this one");
    };
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 200,
      summarize,
      summarizeMinChars: 100,
    });

    const shortContent = "Short content that fits.";
    // Replace ALL occurrences of "deployment" so the callback throws
    const nonDeployContent = longContent.replace(/deployment/gi, "infrastructure");
    const result = await compressor.compressAsync([
      makeMem("1", longContent),                        // Should get LLM summary ("deployment" found)
      makeMem("2", nonDeployContent),                   // LLM fails (no "deployment"), fallback
      makeMem("3", shortContent),                       // Short enough, pass through
    ]);

    expect(result).toHaveLength(3);
    // Memory 1: LLM summarized
    expect(result[0]!.llmSummarized).toBe(true);
    expect(result[0]!.compressed).toBe(true);
    // Memory 2: LLM failed, fallback to sentence extraction
    expect(result[1]!.llmSummarized).toBeUndefined();
    expect(result[1]!.compressed).toBe(true);
    // Memory 3: passed through unchanged
    expect(result[2]!.compressed).toBe(false);
  });

  test("preserves metadata fields through async compression", async () => {
    const summarize = async () => "Summarized.";
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 50,
      summarize,
      summarizeMinChars: 100,
    });
    const mem = makeMem("1", longContent, {
      type: "deployment_info",
      title: "Deploy Pipeline Config",
      confidence: 0.95,
      importance: 0.9,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await compressor.compressAsync([mem]);

    expect(result[0]!.memory.id).toBe("1");
    expect(result[0]!.memory.type).toBe("deployment_info");
    expect(result[0]!.memory.title).toBe("Deploy Pipeline Config");
    expect(result[0]!.memory.confidence).toBe(0.95);
    expect(result[0]!.memory.importance).toBe(0.9);
    expect(result[0]!.memory.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("sync compress never uses LLM summarization", () => {
    const summarize = async () => "should not be called";
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 50,
      summarize,
      summarizeMinChars: 10,
    });

    const result = compressor.compress([makeMem("1", longContent)]);

    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.llmSummarized).toBeUndefined();
  });

  test("default summarizeMinChars is 400", async () => {
    const summarize = async () => "summarized";
    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 200,
      summarize,
    });
    // ~300 chars, below default 400 threshold
    const belowThreshold = "Short line. ".repeat(25);

    const result = await compressor.compressAsync([makeMem("1", belowThreshold)]);

    // Should use sentence extraction because content < 400 chars (default threshold)
    expect(result[0]!.compressed).toBe(true);
    expect(result[0]!.llmSummarized).toBeUndefined();
  });

  test("processes in parallel batches respecting concurrency limit", async () => {
    const callOrder: number[] = [];
    // Each LLM summary takes 50ms; we track start order
    const summarize = async (_content: string, _maxChars: number) => {
      callOrder.push(Date.now());
      await new Promise((r) => setTimeout(r, 20));
      return "summary";
    };

    const compressor = new MemoryCompressor({
      maxCharsPerMemory: 50,
      summarize,
      summarizeMinChars: 30,
    });

    const longContent = "This is a long content string that will be summarized. ".repeat(3);
    const memories = Array.from({ length: 6 }, (_, i) =>
      makeMem(String(i), longContent),
    );

    const start = Date.now();
    // With concurrency 2, 6 memories → 3 batches → ~60ms total
    const result = await compressor.compressAsync(memories, 2);
    const elapsed = Date.now() - start;

    expect(result).toHaveLength(6);
    // Should have taken roughly 3 batches * 20ms each ≈ 60ms
    // (vs 6 * 20ms = 120ms if serial)
    expect(elapsed).toBeLessThan(100);
  });
});
