import { Graphics } from "pixi.js";
import {
  ROAD_WIDTH,
  ROAD_INTERSECTION_RADIUS,
  ROAD_TYPE_COLORS,
  type RoadType,
  getCurrentWorldTheme,
} from "../constants";
import type { WorldNodeData, WorldEdgeData } from "../types";

/**
 * Renders roads between workstation nodes.
 *
 * Batch 5 Phase 2 (§9.5 §3.4): the double-line + dashed center style has
 * been replaced with a single line per edge, colored by the inferred road
 * type (cyan = data, purple = product, amber = control). Flowing particles
 * along the edges are handled by ParticleLayer.
 *
 * Task 13 (§9.5.4): road colors are read from the active WorldTheme for the
 * intersection caps; type colors are theme-independent (semantic).
 */

// Node types that indicate each road type when connected by an edge.
const PRODUCT_NODE_TYPES = new Set([
  "video_workstation",
  "artifact_box",
  "tiktok_station",
]);
const DATA_NODE_TYPES = new Set(["material_library"]);

/** Infer the road type from the connected nodes' types. */
function inferRoadType(from: WorldNodeData, to: WorldNodeData): RoadType {
  if (DATA_NODE_TYPES.has(from.type) || DATA_NODE_TYPES.has(to.type)) return "data";
  if (PRODUCT_NODE_TYPES.has(from.type) || PRODUCT_NODE_TYPES.has(to.type)) return "product";
  return "control";
}

export class RoadLayer {
  private graphics?: Graphics;

  draw(nodes: WorldNodeData[], edges: WorldEdgeData[]): Graphics {
    this.destroy();

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const g = new Graphics();
    const theme = getCurrentWorldTheme();

    // ── Single-line roads colored by inferred type ──
    // Group strokes by road type so each type is a single batch.
    const edgesByType = new Map<RoadType, { from: WorldNodeData; to: WorldNodeData }[]>();
    for (const edge of edges) {
      const from = nodeMap.get(edge.fromNodeId);
      const to = nodeMap.get(edge.toNodeId);
      if (!from || !to) continue;
      const type = inferRoadType(from, to);
      let arr = edgesByType.get(type);
      if (!arr) {
        arr = [];
        edgesByType.set(type, arr);
      }
      arr.push({ from, to });
    }

    for (const [type, edgeList] of edgesByType) {
      const color = ROAD_TYPE_COLORS[type];
      g.setStrokeStyle({
        width: ROAD_WIDTH,
        color,
        alpha: 0.7,
        cap: "round",
        join: "round",
      });
      for (const { from, to } of edgeList) {
        g.moveTo(from.position.x, from.position.y);
        g.lineTo(to.position.x, to.position.y);
      }
      g.stroke();
    }

    // ── Rounded intersection caps at each node ──
    // Drawn in the theme's roadColor (neutral) so junctions blend with all
    // road types meeting at a node.
    for (const node of nodes) {
      g.circle(node.position.x, node.position.y, ROAD_INTERSECTION_RADIUS);
      g.fill({ color: theme.roadColor, alpha: 0.8 });
    }

    // ── Glowing dots at edge midpoints (Batch 5 Phase 2 §3.4) ──
    // A small glowing circle at the midpoint of each edge where road types
    // transition, adding a "data node" topology feel.
    for (const edge of edges) {
      const from = nodeMap.get(edge.fromNodeId);
      const to = nodeMap.get(edge.toNodeId);
      if (!from || !to) continue;
      const type = inferRoadType(from, to);
      const color = ROAD_TYPE_COLORS[type];
      const mx = (from.position.x + to.position.x) / 2;
      const my = (from.position.y + to.position.y) / 2;
      g.circle(mx, my, 2);
      g.fill({ color, alpha: 0.9 });
    }

    this.graphics = g;
    return g;
  }

  destroy() {
    this.graphics?.destroy();
    this.graphics = undefined;
  }
}
