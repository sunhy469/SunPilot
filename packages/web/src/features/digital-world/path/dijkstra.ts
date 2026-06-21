import type { AdjacencyList } from "./graph";

export interface PathResult {
  routeNodeIds: string[];
  distance: number;
}

export function findShortestPath(
  graph: AdjacencyList,
  fromId: string,
  toId: string,
): PathResult | null {
  if (fromId === toId) return { routeNodeIds: [fromId], distance: 0 };

  const distances = new Map<string, number>();
  const previous = new Map<string, string>();
  const visited = new Set<string>();

  for (const nodeId of graph.keys()) {
    distances.set(nodeId, Infinity);
  }
  distances.set(fromId, 0);

  while (true) {
    let current: string | null = null;
    let minDist = Infinity;

    for (const [nodeId, dist] of distances) {
      if (!visited.has(nodeId) && dist < minDist) {
        minDist = dist;
        current = nodeId;
      }
    }

    if (current === null || current === toId) break;
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

  const totalDist = distances.get(toId);
  if (totalDist === undefined || totalDist === Infinity) return null;

  const route: string[] = [];
  let node: string | undefined = toId;
  while (node !== undefined) {
    route.unshift(node);
    node = previous.get(node);
  }

  return { routeNodeIds: route, distance: totalDist };
}
