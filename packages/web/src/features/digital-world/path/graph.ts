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
    if (from) {
      from.push({ nodeId: edge.toNodeId, distance: dist });
    } else {
      // W14: edge references a non-existent node — surface the drop instead
      // of failing silently, so broken world data is easier to diagnose.
      console.warn(
        `[graph] edge "${edge.id}" references unknown fromNodeId "${edge.fromNodeId}" — discarded`,
      );
    }

    if (edge.bidirectional) {
      const to = graph.get(edge.toNodeId);
      if (to) {
        to.push({ nodeId: edge.fromNodeId, distance: dist });
      } else {
        console.warn(
          `[graph] edge "${edge.id}" references unknown toNodeId "${edge.toNodeId}" — discarded`,
        );
      }
    }
  }

  return graph;
}
