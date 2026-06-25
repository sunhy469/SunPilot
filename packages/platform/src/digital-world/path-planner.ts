import type { WorldEdgeRecord } from "@sunpilot/storage";

export function planRoute(
  fromNodeId: string,
  toNodeId: string,
  edges: WorldEdgeRecord[],
): string[] | null {
  // Build adjacency list, validating edge distances as we go.
  const graph = new Map<string, { nodeId: string; distance: number }[]>();
  // F20: Track every node referenced by any edge so endpoint IDs can be
  // validated against the known graph regardless of edge directionality.
  const knownNodes = new Set<string>();
  for (const edge of edges) {
    // F20: Negative (or non-finite) distances corrupt Dijkstra's relaxation
    // step — reject them up front instead of producing nonsense routes.
    if (!Number.isFinite(edge.distance) || edge.distance < 0) {
      throw new Error(
        `Invalid distance on edge ${edge.fromNodeId}→${edge.toNodeId}: ${edge.distance}`,
      );
    }
    knownNodes.add(edge.fromNodeId);
    knownNodes.add(edge.toNodeId);
    if (!graph.has(edge.fromNodeId)) graph.set(edge.fromNodeId, []);
    graph.get(edge.fromNodeId)!.push({ nodeId: edge.toNodeId, distance: edge.distance });
    if (edge.bidirectional) {
      if (!graph.has(edge.toNodeId)) graph.set(edge.toNodeId, []);
      graph.get(edge.toNodeId)!.push({ nodeId: edge.fromNodeId, distance: edge.distance });
    }
  }

  // F20: Validate that the requested endpoints exist in the graph. Throw
  // instead of silently returning null so callers can distinguish "no
  // route between valid nodes" from "referenced a non-existent node".
  if (!knownNodes.has(fromNodeId)) {
    throw new Error(`fromNodeId "${fromNodeId}" does not exist in the graph`);
  }
  if (!knownNodes.has(toNodeId)) {
    throw new Error(`toNodeId "${toNodeId}" does not exist in the graph`);
  }

  if (fromNodeId === toNodeId) return [fromNodeId];

  // Dijkstra
  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  const visited = new Set<string>();

  for (const nodeId of graph.keys()) {
    distances.set(nodeId, Infinity);
  }
  distances.set(fromNodeId, 0);

  while (true) {
    let current: string | null = null;
    let minDist = Infinity;
    for (const [nodeId, dist] of distances) {
      if (!visited.has(nodeId) && dist < minDist) {
        minDist = dist;
        current = nodeId;
      }
    }
    if (current === null || current === toNodeId) break;
    visited.add(current);

    const neighbors = graph.get(current) ?? [];
    for (const { nodeId, distance } of neighbors) {
      if (visited.has(nodeId)) continue;
      const alt = minDist + distance;
      if (alt < (distances.get(nodeId) ?? Infinity)) {
        distances.set(nodeId, alt);
        previous.set(nodeId, current);
      }
    }
  }

  if ((distances.get(toNodeId) ?? Infinity) === Infinity) return null;

  const route: string[] = [];
  let node: string | undefined = toNodeId;
  while (node !== undefined) {
    route.unshift(node);
    node = previous.get(node);
  }
  return route;
}
