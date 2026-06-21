import { Graphics } from "pixi.js";
import { GRID_COLOR, GRID_SPACING } from "../constants";

export class WorldGrid {
  private graphics?: Graphics;

  draw(width: number, height: number): Graphics {
    this.destroy();

    const g = new Graphics();
    g.setStrokeStyle({ width: 1, color: GRID_COLOR });

    for (let x = 0; x <= width; x += GRID_SPACING) {
      g.moveTo(x, 0).lineTo(x, height);
    }
    for (let y = 0; y <= height; y += GRID_SPACING) {
      g.moveTo(0, y).lineTo(width, y);
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
