import { Application, Graphics, Text } from "pixi.js";

export class WorldApp {
  private app?: Application;

  async mount(container: HTMLElement) {
    const app = new Application();
    await app.init({
      width: container.clientWidth,
      height: container.clientHeight,
      backgroundColor: 0x0f172a,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      powerPreference: "high-performance",
    });

    container.appendChild(app.canvas);
    this.app = app;
    this.drawPlaceholder();
  }

  resize(width: number, height: number) {
    this.app?.renderer.resize(width, height);
  }

  destroy() {
    this.app?.destroy(true);
    this.app = undefined;
  }

  private drawPlaceholder() {
    if (!this.app) return;

    const bg = new Graphics()
      .rect(0, 0, this.app.renderer.width, this.app.renderer.height)
      .fill(0x0f172a);

    const label = new Text({
      text: "Digital World",
      style: {
        fill: 0xffffff,
        fontSize: 24,
        fontFamily: "sans-serif",
      },
    });
    label.x = 32;
    label.y = 32;

    this.app.stage.addChild(bg, label);
  }
}
