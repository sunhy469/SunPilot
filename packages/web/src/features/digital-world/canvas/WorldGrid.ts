import { Graphics } from "pixi.js";
import { GRID_DOT_RADIUS, GRID_SPACING, getCurrentWorldTheme } from "../constants";

/**
 * Renders the world grid as a dotted grid (§9.3.3). Each grid intersection
 * is drawn as a small filled circle instead of solid lines, giving a
 * lighter, more modern look that fades into the background.
 *
 * Task 13 (§9.5.4): the dot color is read from the active WorldTheme so the
 * grid recolors when the theme is toggled.
 */
export class WorldGrid {
  private graphics?: Graphics;

  draw(width: number, height: number): Graphics {
    this.destroy();

    const g = new Graphics();
    const theme = getCurrentWorldTheme();

    // Draw a small dot at each grid intersection. Using a single fill batch
    // for all circles keeps this efficient even for large grids.
    for (let x = 0; x <= width; x += GRID_SPACING) {
      for (let y = 0; y <= height; y += GRID_SPACING) {
        g.circle(x, y, GRID_DOT_RADIUS);
      }
    }
    g.fill({ color: theme.gridColor, alpha: 0.5 });

    this.graphics = g;
    return g;
  }

  destroy() {
    this.graphics?.destroy();
    this.graphics = undefined;
  }
}
