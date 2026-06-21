import type { WorldEdgeRecord } from "@sunpilot/storage";

export function planRoute(
  fromNodeId: string,
  toNodeId: string,
  edges: WorldEdgeRecord[],
): string[] | null {
  if (fromNodeId === toNodeId) return [fromNodeId];

  // Build adjacency list
  const graph = new Map<string, { nodeId: string; distance: number }[]>();
  for (const edge of edges) {
    if (!graph.has(edge.fromNodeId)) graph.set(edge.fromNodeId, []);
    graph.get(edge.fromNodeId)!.push({ nodeId: edge.toNodeId, distance: edge.distance });
    if (edge.bidirectional) {
      if (!graph.has(edge.toNodeId)) graph.set(edge.toNodeId, []);
      graph.get(edge.toNodeId)!.push({ nodeId: edge.fromNodeId, distance: edge.distance });
    }
  }

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
