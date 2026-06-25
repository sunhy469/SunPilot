import { useCallback, useEffect, useRef } from "react";
import { buildGraph } from "../path/graph";
import { findShortestPath } from "../path/dijkstra";
import { RouteAnimator } from "../path/route-animation";
import type { WorldApp } from "../canvas/WorldApp";

export function useBeingMovement(worldAppRef: React.MutableRefObject<WorldApp | null>) {
  const animatorRef = useRef<RouteAnimator | null>(null);

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

    const graph = buildGraph(world.nodes, world.edges);
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
