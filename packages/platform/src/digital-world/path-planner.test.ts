import { describe, expect, test } from "vitest";
import type { WorldEdgeRecord } from "@sunpilot/storage";
import { planRoute } from "./path-planner.js";

function edge(
  from: string,
  to: string,
  distance: number,
  bidirectional = true,
): WorldEdgeRecord {
  return {
    id: `edge_${from}_${to}`,
    fromNodeId: from,
    toNodeId: to,
    distance,
    bidirectional,
    locked: false,
  };
}

describe("planRoute", () => {
  test("returns direct route for adjacent nodes", () => {
    const edges = [edge("a", "b", 5)];
    expect(planRoute("a", "b", edges)).toEqual(["a", "b"]);
  });

  test("returns reverse route for bidirectional edges", () => {
    const edges = [edge("a", "b", 5)];
    expect(planRoute("b", "a", edges)).toEqual(["b", "a"]);
  });

  test("returns null when no path exists (disconnected graph)", () => {
    const edges = [edge("a", "b", 1), edge("c", "d", 1)];
    expect(planRoute("a", "d", edges)).toBeNull();
  });

  test("finds shortest path among multiple routes", () => {
    const edges = [
      edge("a", "b", 1),
      edge("b", "c", 1),
      edge("a", "c", 10),
    ];
    expect(planRoute("a", "c", edges)).toEqual(["a", "b", "c"]);
  });

  test("returns single-element route when from === to", () => {
    const edges = [edge("a", "b", 1)];
    expect(planRoute("a", "a", edges)).toEqual(["a"]);
  });

  test("respects unidirectional edges (no reverse path)", () => {
    const edges = [edge("a", "b", 1, false)];
    expect(planRoute("a", "b", edges)).toEqual(["a", "b"]);
    expect(planRoute("b", "a", edges)).toBeNull();
  });

  test("throws on negative distance", () => {
    const edges = [edge("a", "b", -1)];
    expect(() => planRoute("a", "b", edges)).toThrow("Invalid distance");
  });

  test("throws on non-finite distance (NaN)", () => {
    const edges = [edge("a", "b", NaN)];
    expect(() => planRoute("a", "b", edges)).toThrow("Invalid distance");
  });

  test("throws on non-finite distance (Infinity)", () => {
    const edges = [edge("a", "b", Infinity)];
    expect(() => planRoute("a", "b", edges)).toThrow("Invalid distance");
  });

  test("throws when fromNodeId does not exist in graph", () => {
    const edges = [edge("a", "b", 1)];
    expect(() => planRoute("zzz", "b", edges)).toThrow(
      'fromNodeId "zzz" does not exist in the graph',
    );
  });

  test("throws when toNodeId does not exist in graph", () => {
    const edges = [edge("a", "b", 1)];
    expect(() => planRoute("a", "zzz", edges)).toThrow(
      'toNodeId "zzz" does not exist in the graph',
    );
  });

  test("handles a complex graph with multiple branches", () => {
    // Graph: a-1-b-1-c, a-5-d-1-c
    // Shortest a→c: a→b→c (cost 2) vs a→d→c (cost 6)
    const edges = [
      edge("a", "b", 1),
      edge("b", "c", 1),
      edge("a", "d", 5),
      edge("d", "c", 1),
    ];
    expect(planRoute("a", "c", edges)).toEqual(["a", "b", "c"]);
  });

  test("handles empty edge list (no nodes known)", () => {
    expect(() => planRoute("a", "b", [])).toThrow(
      'fromNodeId "a" does not exist in the graph',
    );
  });
});
