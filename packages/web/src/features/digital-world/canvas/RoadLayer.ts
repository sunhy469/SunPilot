import { Graphics } from "pixi.js";
import {
  ROAD_WIDTH,
  ROAD_CENTER_WIDTH,
  ROAD_DASH_LENGTH,
  ROAD_DASH_GAP,
  ROAD_INTERSECTION_RADIUS,
  getCurrentWorldTheme,
} from "../constants";
import type { WorldNodeData, WorldEdgeData } from "../types";

/**
 * Renders roads between workstation nodes (§9.3.3).
 *
 * Each road is drawn as:
 *   1. A solid outer line (theme.roadColor, ROAD_WIDTH) — the road surface.
 *   2. A dashed center line (theme.roadCenterColor) — the lane divider.
 *
 * Additionally, a rounded "intersection cap" circle is drawn at every node
 * position so roads connect smoothly at junctions.
 *
 * Task 13 (§9.5.4): road colors are read from the active WorldTheme.
 */
export class RoadLayer {
  private graphics?: Graphics;

  draw(nodes: WorldNodeData[], edges: WorldEdgeData[]): Graphics {
    this.destroy();

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const g = new Graphics();
    const theme = getCurrentWorldTheme();

    // ── 1. Road surface (solid lines between connected nodes) ──
    g.setStrokeStyle({
      width: ROAD_WIDTH,
      color: theme.roadColor,
      cap: "round",
      join: "round",
    });
    for (const edge of edges) {
      const from = nodeMap.get(edge.fromNodeId);
      const to = nodeMap.get(edge.toNodeId);
      if (!from || !to) continue;

      g.moveTo(from.position.x, from.position.y);
      g.lineTo(to.position.x, to.position.y);
    }
    g.stroke();

    // ── 2. Dashed center line (lane divider) ──
    // PixiJS 8 Graphics has no native dash support, so we manually emit
    // short segments along each edge.
    g.setStrokeStyle({
      width: ROAD_CENTER_WIDTH,
      color: theme.roadCenterColor,
      cap: "butt",
    });
    const dashLen = ROAD_DASH_LENGTH;
    const gapLen = ROAD_DASH_GAP;
    const stepLen = dashLen + gapLen;

    for (const edge of edges) {
      const from = nodeMap.get(edge.fromNodeId);
      const to = nodeMap.get(edge.toNodeId);
      if (!from || !to) continue;

      const fx = from.position.x;
      const fy = from.position.y;
      const tx = to.position.x;
      const ty = to.position.y;
      const dx = tx - fx;
      const dy = ty - fy;
      const dist = Math.hypot(dx, dy);
      if (dist < stepLen) continue; // too short to dash

      const ux = dx / dist;
      const uy = dy / dist;

      // Skip the first/last bit so dashes don't overlap the intersection cap.
      const margin = ROAD_INTERSECTION_RADIUS;
      const start = margin;
      const end = dist - margin;

      for (let pos = start; pos + dashLen <= end; pos += stepLen) {
        const sx = fx + ux * pos;
        const sy = fy + uy * pos;
        const ex = fx + ux * (pos + dashLen);
        const ey = fy + uy * (pos + dashLen);
        g.moveTo(sx, sy);
        g.lineTo(ex, ey);
      }
    }
    g.stroke();

    // ── 3. Rounded intersection caps at each node ──
    // These cover the point where multiple roads meet, giving a smooth
    // rounded junction instead of a sharp crossing.
    for (const node of nodes) {
      g.circle(node.position.x, node.position.y, ROAD_INTERSECTION_RADIUS);
      g.fill({ color: theme.roadColor });
    }

    this.graphics = g;
    return g;
  }

  destroy() {
    this.graphics?.destroy();
    this.graphics = undefined;
  }
}
