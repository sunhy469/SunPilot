import type { WorldNodeData, WorldEdgeData } from "../types";

export type AdjacencyList = Map<string, { nodeId: string; distance: number }[]>;

export function buildGraph(
  nodes: WorldNodeData[],
  edges: WorldEdgeData[],
): AdjacencyList {
  const graph: AdjacencyList = new Map();

  for (const node of nodes) {
    graph.set(node.id, []);
  }

  for (const edge of edges) {
    const dist = edge.distance;
    const from = graph.get(edge.fromNodeId);
    if (from) from.push({ nodeId: edge.toNodeId, distance: dist });

    if (edge.bidirectional) {
      const to = graph.get(edge.toNodeId);
      if (to) to.push({ nodeId: edge.fromNodeId, distance: dist });
    }
  }

  return graph;
}
