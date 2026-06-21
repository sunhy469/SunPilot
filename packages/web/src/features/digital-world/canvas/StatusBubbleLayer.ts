import { Container, Graphics, Text } from "pixi.js";

const BUBBLE_PADDING_X = 12;
const BUBBLE_PADDING_Y = 7;
const BUBBLE_OFFSET_Y = -78;
const BUBBLE_RADIUS = 8;
const BUBBLE_BG = 0xffffff;
const BUBBLE_BORDER = 0xd1d5db;
const BUBBLE_TAIL_SIZE = 6;

export class StatusBubbleLayer {
  readonly container: Container;

  constructor() {
    this.container = new Container();
    this.container.visible = false;
  }

  update(text: string, beingX: number, beingY: number) {
    this.container.removeChildren();
    this.container.visible = true;

    // 文字
    const label = new Text({
      text,
      style: {
        fill: 0x374151,
        fontSize: 12,
        fontFamily: "sans-serif",
        fontWeight: "500",
      },
    });

    const bw = label.width + BUBBLE_PADDING_X * 2;
    const bh = label.height + BUBBLE_PADDING_Y * 2;

    // 气泡背景（含小三角）
    const bg = new Graphics();

    // 圆角矩形
    bg.roundRect(-bw / 2, -bh, bw, bh, BUBBLE_RADIUS);
    bg.fill({ color: BUBBLE_BG });
    bg.stroke({ color: BUBBLE_BORDER, width: 1 });

    // 小三角（单独的三角形路径）
    bg.moveTo(-BUBBLE_TAIL_SIZE, 0);
    bg.lineTo(0, BUBBLE_TAIL_SIZE);
    bg.lineTo(BUBBLE_TAIL_SIZE, 0);
    bg.closePath();
    bg.fill({ color: BUBBLE_BG });
    // 三角边框（左右两条线）
    bg.moveTo(-BUBBLE_TAIL_SIZE, 0);
    bg.lineTo(0, BUBBLE_TAIL_SIZE);
    bg.moveTo(BUBBLE_TAIL_SIZE, 0);
    bg.lineTo(0, BUBBLE_TAIL_SIZE);
    bg.stroke({ color: BUBBLE_BORDER, width: 1 });

    this.container.addChild(bg);
    this.container.addChild(label);

    label.anchor.set(0.5);
    label.x = 0;
    label.y = -bh / 2;

    this.container.x = beingX;
    this.container.y = beingY + BUBBLE_OFFSET_Y;
  }

  hide() {
    this.container.visible = false;
  }

  destroy() {
    this.container.destroy({ children: true });
  }
}
