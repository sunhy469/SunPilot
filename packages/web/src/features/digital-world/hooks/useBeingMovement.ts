import { useCallback, useEffect, useRef } from "react";
import { buildGraph, type AdjacencyList } from "../path/graph";
import { findShortestPath } from "../path/dijkstra";
import { RouteAnimator } from "../path/route-animation";
import type { WorldApp } from "../canvas/WorldApp";
import type { WorldNodeData, WorldEdgeData } from "../types";

export function useBeingMovement(worldAppRef: React.MutableRefObject<WorldApp | null>) {
  const animatorRef = useRef<RouteAnimator | null>(null);

  // §9.2.6: pathfinding graph cache. The graph only depends on node ids + edge
  // data, so we rebuild it solely when the nodes/edges array references change
  // (WorldApp.setData swaps in new arrays on structural changes) instead of on
  // every triggerMoveTo() call.
  const graphRef = useRef<AdjacencyList | null>(null);
  const graphNodesRef = useRef<WorldNodeData[] | null>(null);
  const graphEdgesRef = useRef<WorldEdgeData[] | null>(null);

  // 组件卸载时清理动画
  useEffect(() => {
    return () => {
      if (animatorRef.current) {
        animatorRef.current.stop();
        animatorRef.current = null;
      }
    };
  }, []);

  const triggerMoveTo = useCallback((targetNodeId: string) => {
    const world = worldAppRef.current;
    if (!world || !world.being || !world.statusBubble || !world.ticker) return;

    // 停止之前的动画
    if (animatorRef.current) {
      animatorRef.current.stop();
      animatorRef.current = null;
      world.registerAnimator(null);
    }

    // §9.2.6: rebuild the graph only when the nodes/edges references change.
    if (
      graphRef.current === null ||
      graphNodesRef.current !== world.nodes ||
      graphEdgesRef.current !== world.edges
    ) {
      graphRef.current = buildGraph(world.nodes, world.edges);
      graphNodesRef.current = world.nodes;
      graphEdgesRef.current = world.edges;
    }
    const graph = graphRef.current;
    const result = findShortestPath(graph, world.beingData.currentNodeId, targetNodeId);
    if (!result) return;

    world.updateBeingStatus("移动中...");
    world.updateBeingVisualStatus("moving");

    const animator = new RouteAnimator(
      world.ticker,
      world.being,
      world.statusBubble,
      result.routeNodeIds,
      world.nodes,
    );

    animator.onNodeReached((nodeId) => {
      world.updateBeingPosition(nodeId);
    });

    animator.onComplete(() => {
      world.updateBeingPosition(targetNodeId);
      const targetNode = world.nodes.find((n) => n.id === targetNodeId);
      world.updateBeingStatus(`已到达${targetNode?.name ?? targetNodeId}`);
      world.updateBeingVisualStatus("idle");
      world.registerAnimator(null);
      animatorRef.current = null;
    });

    animatorRef.current = animator;
    // C19/W7: register so WorldApp knows an animation is running (skips
    // polling position jumps) and can stop it cleanly on destroy.
    world.registerAnimator(animator);
    animator.start();
  }, [worldAppRef]);

  return { triggerMoveTo };
}
