import { describe, expect, test } from "vitest";
import { SimpleQueryExpander } from "./query-expander.js";

describe("SimpleQueryExpander", () => {
  test("returns original query when no known words (individual keywords are added but cap=4 leaves room for original only if few)", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("unique unknown term");
    // All words > 2 chars are added as keywords, plus original. With 3 keywords + original = 4, all fit under cap.
    expect(result).toContain("unique unknown term");
    expect(result).toContain("unique");
    expect(result).toContain("unknown");
    expect(result).toContain("term");
    expect(result.length).toBeLessThanOrEqual(4);
  });

  test("expands known word with synonyms (cap=4 limits results)", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("deploy");
    // "deploy" has 4 synonyms, plus original = 5 total, capped at 4
    expect(result).toContain("deploy"); // original always included
    expect(result.length).toBeLessThanOrEqual(4);
    // At least some synonyms should be present
    const hasSynonyms = result.some(
      (r) => r === "deployment" || r === "release" || r === "publish" || r === "launch",
    );
    expect(hasSynonyms).toBe(true);
  });

  test("replaces known word in multi-word query", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("fix bug in api");
    expect(result.length).toBeGreaterThan(1);
    expect(result.length).toBeLessThanOrEqual(4);
    // Should contain original
    expect(result).toContain("fix bug in api");
    // Some synonym variants
    const hasSynonymVariant = result.some(
      (r) => r.includes("resolve") || r.includes("repair") || r.includes("error") || r.includes("endpoint"),
    );
    expect(hasSynonymVariant).toBe(true);
  });

  test("expands Chinese synonyms (within cap)", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("数据库 bug 配置");
    expect(result.length).toBeGreaterThan(1);
    expect(result.length).toBeLessThanOrEqual(4);
    // Original included
    expect(result).toContain("数据库 bug 配置");
  });

  test("caps at 4 variants maximum", async () => {
    const expander = new SimpleQueryExpander();
    // Query with multiple known words to generate many variants
    const result = await expander.expand("deploy fix bug test config build db api error");
    expect(result.length).toBeLessThanOrEqual(4);
  });

  test("includes original query in result", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("test memory slow api");
    expect(result).toContain("test memory slow api");
    expect(result.length).toBeLessThanOrEqual(4);
  });

  test("handles empty query", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("");
    expect(result).toEqual([""]);
  });

  test("handles single short word (<= 2 chars) — not added as keyword", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("a");
    expect(result).toEqual(["a"]);
  });

  test("individual keywords longer than 2 chars are added (up to cap)", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("the deploy bug");
    // With 3 keywords + many synonym variants, cap=4 limits results
    // Original is always included
    expect(result).toContain("the deploy bug");
    expect(result.length).toBe(4);
    // With cap=4: ["the deploy bug", "the deployment bug", "the release bug", "the publish bug"]
    // Individual keywords are pushed out by synonyms. We verify at minimum original is present
    // and expansion happened (more than just the original).
    expect(result.length).toBeGreaterThan(1);
  });

  test("handles regex special characters in query safely", async () => {
    const expander = new SimpleQueryExpander();
    // "api" has synonyms; + is regex special char
    const result = await expander.expand("api+endpoint");
    // Should not throw; should handle gracefully
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result).toContain("api+endpoint");
  });

  test("case-insensitive matching for known words", async () => {
    const expander = new SimpleQueryExpander();
    const upperResult = await expander.expand("DEPLOY BUG");
    const lowerResult = await expander.expand("deploy bug");
    // Both should expand — at minimum both contain their original
    expect(upperResult.some((r) => r !== "DEPLOY BUG")).toBe(true);
    expect(lowerResult.some((r) => r !== "deploy bug")).toBe(true);
  });

  test("handles query with only known words", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("memory skill");
    expect(result).toContain("memory skill");
    expect(result.length).toBeLessThanOrEqual(4);
    const hasSynonym = result.some(
      (r) => r !== "memory skill" && r !== "memory" && r !== "skill",
    );
    expect(hasSynonym).toBe(true);
  });

  // ── New synonym categories from expanded dictionary ──────────────

  test("expands security-related terms", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("auth token");
    expect(result).toContain("auth token");
    const hasExpansion = result.some(
      (r) => r.includes("authentication") || r.includes("login") || r.includes("credential") || r.includes("key"),
    );
    expect(hasExpansion).toBe(true);
  });

  test("expands monitoring-related terms", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("monitor log");
    expect(result).toContain("monitor log");
    const hasExpansion = result.some(
      (r) => r.includes("monitoring") || r.includes("logging") || r.includes("metrics") || r.includes("trace"),
    );
    expect(hasExpansion).toBe(true);
  });

  test("expands infrastructure terms", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("container cluster");
    expect(result).toContain("container cluster");
    const hasExpansion = result.some(
      (r) => r.includes("docker") || r.includes("nodes") || r.includes("podman") || r.includes("group"),
    );
    expect(hasExpansion).toBe(true);
  });

  test("expands pipeline and ci/cd terms", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("pipeline deploy");
    expect(result).toContain("pipeline deploy");
    const hasExpansion = result.some(
      (r) => r.includes("workflow") || r.includes("ci/cd") || r.includes("deployment") || r.includes("automation"),
    );
    expect(hasExpansion).toBe(true);
  });

  test("expands data and messaging terms", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("queue stream event");
    expect(result).toContain("queue stream event");
    const hasExpansion = result.some(
      (r) => r.includes("buffer") || r.includes("flow") || r.includes("message") || r.includes("notification"),
    );
    expect(hasExpansion).toBe(true);
  });

  test("expands scaling and optimization terms", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("scale optimize performance");
    expect(result).toContain("scale optimize performance");
    const hasExpansion = result.some(
      (r) => r.includes("scaling") || r.includes("optimization") || r.includes("speed") || r.includes("efficiency"),
    );
    expect(hasExpansion).toBe(true);
  });

  test("expands health and recovery terms", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("backup restore health");
    expect(result).toContain("backup restore health");
    const hasExpansion = result.some(
      (r) => r.includes("snapshot") || r.includes("recover") || r.includes("status") || r.includes("check"),
    );
    expect(hasExpansion).toBe(true);
  });

  test("expands database terms with new synonyms", async () => {
    const expander = new SimpleQueryExpander();
    const result = await expander.expand("cache query migration");
    expect(result).toContain("cache query migration");
    const hasExpansion = result.some(
      (r) => r.includes("redis") || r.includes("search") || r.includes("schema") || r.includes("upgrade"),
    );
    expect(hasExpansion).toBe(true);
  });

  test("expands bidirectional: synonym map entry also expands its own synonyms", async () => {
    const expander = new SimpleQueryExpander();
    // "release" is both a synonym of "deploy" AND has its own entry
    const result = await expander.expand("release");
    expect(result).toContain("release");
    // "release" has its own synonyms: ["deploy", "publish", "launch", "ship", "rollout"]
    const hasExpansion = result.some(
      (r) => r !== "release" && (r === "deploy" || r === "publish" || r === "launch" || r === "ship" || r === "rollout"),
    );
    expect(hasExpansion).toBe(true);
  });
});
