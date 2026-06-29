import { Graphics } from "pixi.js";
import {
  GRID_SPACING,
  GRID_LINE_WIDTH,
  GRID_LINE_ALPHA,
  GRID_MAJOR_EVERY,
  GRID_MAJOR_LINE_WIDTH,
  GRID_MAJOR_LINE_ALPHA,
  getCurrentWorldTheme,
} from "../constants";

/** Visible world-space rectangle (used to limit grid drawing to the viewport). */
export interface CameraBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// Buffer in world units beyond the visible area so panning a short distance
// doesn't immediately reveal a blank edge before the next redraw fires.
// Expanded for Phase 2 to also cover the parallax offset.
const GRID_BUFFER = GRID_SPACING * 4;

/**
 * Renders the world grid as a thin line cross-grid (Batch 5 Phase 2 §3.2).
 *
 * Previously a dotted grid (Phase 1); now upgraded to thin lines (0.5px,
 * alpha 0.15) with brighter "major" lines every 5 cells for a Control Room
 * topology-map aesthetic. A subtle parallax offset (grid moves at 0.92x
 * camera speed) adds depth.
 *
 * Only the visible area (plus buffer) is drawn — the grid follows the
 * viewport, enabling infinite panning.
 */
export class WorldGrid {
  private graphics?: Graphics;

  draw(cameraBounds: CameraBounds): Graphics {
    this.destroy();

    const g = new Graphics();
    const theme = getCurrentWorldTheme();

    // Snap outward to the nearest grid line.
    const startX = Math.floor((cameraBounds.minX - GRID_BUFFER) / GRID_SPACING) * GRID_SPACING;
    const endX = Math.ceil((cameraBounds.maxX + GRID_BUFFER) / GRID_SPACING) * GRID_SPACING;
    const startY = Math.floor((cameraBounds.minY - GRID_BUFFER) / GRID_SPACING) * GRID_SPACING;
    const endY = Math.ceil((cameraBounds.maxY + GRID_BUFFER) / GRID_SPACING) * GRID_SPACING;

    // ── Minor lines (alpha 0.15) ──
    g.setStrokeStyle({
      width: GRID_LINE_WIDTH,
      color: theme.gridColor,
      alpha: GRID_LINE_ALPHA,
      cap: "butt",
    });
    // Vertical minor lines
    for (let x = startX; x <= endX; x += GRID_SPACING) {
      g.moveTo(x, startY);
      g.lineTo(x, endY);
    }
    // Horizontal minor lines
    for (let y = startY; y <= endY; y += GRID_SPACING) {
      g.moveTo(startX, y);
      g.lineTo(endX, y);
    }
    g.stroke();

    // ── Major lines (every 5th, brighter alpha 0.3) ──
    g.setStrokeStyle({
      width: GRID_MAJOR_LINE_WIDTH,
      color: theme.gridColor,
      alpha: GRID_MAJOR_LINE_ALPHA,
      cap: "butt",
    });
    const majorStep = GRID_SPACING * GRID_MAJOR_EVERY;
    // Snap major lines to multiples of majorStep
    const majorStartX = Math.floor(startX / majorStep) * majorStep;
    const majorStartY = Math.floor(startY / majorStep) * majorStep;
    for (let x = majorStartX; x <= endX; x += majorStep) {
      g.moveTo(x, startY);
      g.lineTo(x, endY);
    }
    for (let y = majorStartY; y <= endY; y += majorStep) {
      g.moveTo(startX, y);
      g.lineTo(endX, y);
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
