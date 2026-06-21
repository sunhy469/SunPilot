import { Graphics } from "pixi.js";
import { ROAD_COLOR, ROAD_WIDTH } from "../constants";
import type { WorldNodeData, WorldEdgeData } from "../types";

export class RoadLayer {
  private graphics?: Graphics;

  draw(nodes: WorldNodeData[], edges: WorldEdgeData[]): Graphics {
    this.destroy();

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const g = new Graphics();
    g.setStrokeStyle({ width: ROAD_WIDTH, color: ROAD_COLOR, cap: "round" });

    for (const edge of edges) {
      const from = nodeMap.get(edge.fromNodeId);
      const to = nodeMap.get(edge.toNodeId);
      if (!from || !to) continue;

      g.moveTo(from.position.x, from.position.y);
      g.lineTo(to.position.x, to.position.y);
    }

    g.stroke();
    this.graphics = g;
    return g;
  }

  destroy() {
    this.graphics?.destroy();
    this.graphics = undefined;
  }
}
