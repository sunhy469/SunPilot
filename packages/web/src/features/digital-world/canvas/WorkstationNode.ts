import { Container, Graphics, Text } from "pixi.js";
import { NODE_BORDER_RADIUS } from "../constants";
import type { WorldNodeData } from "../types";

const NODE_ACCENT_COLORS: Record<string, number> = {
  home: 0xf59e0b,
  video_workstation: 0x2563eb,
  artifact_box: 0x8b5cf6,
  tiktok_station: 0x06b6d4,
  material_library: 0x10b981,
  status_station: 0x6b7280,
};

// ── icon drawing helpers (all pure Graphics, no emoji) ──────────────

function drawHomeIcon(g: Graphics, accent: number, cx: number, cy: number, s: number): void {
  // roof triangle
  g.moveTo(cx, cy - s * 0.45);
  g.lineTo(cx - s * 0.4, cy - s * 0.05);
  g.lineTo(cx + s * 0.4, cy - s * 0.05);
  g.closePath();
  g.fill({ color: accent });

  // body
  g.rect(cx - s * 0.32, cy - s * 0.05, s * 0.64, s * 0.45);
  g.fill({ color: 0xfef3c7 });

  // door
  g.rect(cx - s * 0.08, cy + s * 0.12, s * 0.16, s * 0.28);
  g.fill({ color: accent });

  // window
  g.rect(cx + s * 0.12, cy + s * 0.02, s * 0.14, s * 0.14);
  g.fill({ color: 0x93c5fd });
  g.rect(cx + s * 0.12, cy + s * 0.02, s * 0.14, s * 0.14);
  g.stroke({ color: 0x60a5fa, width: 1 });
}

function drawVideoWorkstationIcon(g: Graphics, accent: number, cx: number, cy: number, s: number): void {
  // monitor screen
  g.roundRect(cx - s * 0.38, cy - s * 0.38, s * 0.76, s * 0.48, 3);
  g.fill({ color: 0x1e3a5f });
  g.roundRect(cx - s * 0.38, cy - s * 0.38, s * 0.76, s * 0.48, 3);
  g.stroke({ color: accent, width: 1.5 });

  // play button triangle on screen
  g.moveTo(cx - s * 0.06, cy - s * 0.26);
  g.lineTo(cx + s * 0.14, cy - s * 0.14);
  g.lineTo(cx - s * 0.06, cy - s * 0.02);
  g.closePath();
  g.fill({ color: 0xffffff });

  // stand
  g.rect(cx - s * 0.04, cy + s * 0.1, s * 0.08, s * 0.12);
  g.fill({ color: 0x9ca3af });

  // base
  g.roundRect(cx - s * 0.18, cy + s * 0.22, s * 0.36, s * 0.06, 2);
  g.fill({ color: 0x9ca3af });

  // timeline bar below monitor
  g.roundRect(cx - s * 0.34, cy + s * 0.32, s * 0.68, s * 0.06, 2);
  g.fill({ color: 0xe5e7eb });
  g.roundRect(cx - s * 0.34, cy + s * 0.32, s * 0.3, s * 0.06, 2);
  g.fill({ color: accent });
}

function drawArtifactBoxIcon(g: Graphics, accent: number, cx: number, cy: number, s: number): void {
  // box back face (3D effect)
  g.moveTo(cx - s * 0.3, cy - s * 0.2);
  g.lineTo(cx - s * 0.1, cy - s * 0.35);
  g.lineTo(cx + s * 0.3, cy - s * 0.35);
  g.lineTo(cx + s * 0.1, cy - s * 0.2);
  g.closePath();
  g.fill({ color: 0xc4b5fd });

  // box right face (3D effect)
  g.moveTo(cx + s * 0.1, cy - s * 0.2);
  g.lineTo(cx + s * 0.3, cy - s * 0.35);
  g.lineTo(cx + s * 0.3, cy + s * 0.05);
  g.lineTo(cx + s * 0.1, cy + s * 0.2);
  g.closePath();
  g.fill({ color: 0xa78bfa });

  // box front face
  g.rect(cx - s * 0.3, cy - s * 0.2, s * 0.4, s * 0.4);
  g.fill({ color: 0xddd6fe });
  g.rect(cx - s * 0.3, cy - s * 0.2, s * 0.4, s * 0.4);
  g.stroke({ color: accent, width: 1.2 });

  // open flaps
  g.moveTo(cx - s * 0.3, cy - s * 0.2);
  g.lineTo(cx - s * 0.38, cy - s * 0.32);
  g.lineTo(cx - s * 0.08, cy - s * 0.32);
  g.lineTo(cx - s * 0.1, cy - s * 0.2);
  g.closePath();
  g.fill({ color: 0xc4b5fd });

  g.moveTo(cx + s * 0.1, cy - s * 0.2);
  g.lineTo(cx + s * 0.08, cy - s * 0.32);
  g.lineTo(cx + s * 0.38, cy - s * 0.32);
  g.lineTo(cx + s * 0.3, cy - s * 0.2);
  g.closePath();
  g.fill({ color: 0xc4b5fd });

  // small cubes inside
  g.rect(cx - s * 0.2, cy + s * 0.0, s * 0.12, s * 0.12);
  g.fill({ color: accent });
  g.rect(cx - s * 0.04, cy + s * 0.04, s * 0.1, s * 0.1);
  g.fill({ color: 0x7c3aed });
}

function drawTiktokStationIcon(g: Graphics, accent: number, cx: number, cy: number, s: number): void {
  // phone body
  g.roundRect(cx - s * 0.22, cy - s * 0.4, s * 0.44, s * 0.75, 5);
  g.fill({ color: 0x0e1621 });
  g.roundRect(cx - s * 0.22, cy - s * 0.4, s * 0.44, s * 0.75, 5);
  g.stroke({ color: accent, width: 1.5 });

  // screen area
  g.roundRect(cx - s * 0.18, cy - s * 0.3, s * 0.36, s * 0.5, 2);
  g.fill({ color: 0x164e63 });

  // upload arrow
  g.moveTo(cx, cy - s * 0.18);
  g.lineTo(cx - s * 0.1, cy - s * 0.06);
  g.lineTo(cx - s * 0.04, cy - s * 0.06);
  g.lineTo(cx - s * 0.04, cy + s * 0.06);
  g.lineTo(cx + s * 0.04, cy + s * 0.06);
  g.lineTo(cx + s * 0.04, cy - s * 0.06);
  g.lineTo(cx + s * 0.1, cy - s * 0.06);
  g.closePath();
  g.fill({ color: 0xffffff });

  // play symbol (small triangle) next to arrow
  g.moveTo(cx + s * 0.08, cy + s * 0.08);
  g.lineTo(cx + s * 0.16, cy + s * 0.14);
  g.lineTo(cx + s * 0.08, cy + s * 0.2);
  g.closePath();
  g.fill({ color: accent });

  // home indicator bar at bottom of phone
  g.roundRect(cx - s * 0.08, cy + s * 0.28, s * 0.16, s * 0.03, 1.5);
  g.fill({ color: 0x6b7280 });
}

function drawMaterialLibraryIcon(g: Graphics, accent: number, cx: number, cy: number, s: number): void {
  const cabinetW = s * 0.5;
  const cabinetH = s * 0.72;
  const cabinetX = cx - cabinetW / 2;
  const cabinetY = cy - cabinetH / 2;

  // cabinet body
  g.roundRect(cabinetX, cabinetY, cabinetW, cabinetH, 3);
  g.fill({ color: 0xd1fae5 });
  g.roundRect(cabinetX, cabinetY, cabinetW, cabinetH, 3);
  g.stroke({ color: accent, width: 1.2 });

  // drawer lines (3 drawers)
  const drawerH = cabinetH / 3;
  for (let i = 1; i < 3; i++) {
    g.moveTo(cabinetX + 2, cabinetY + drawerH * i);
    g.lineTo(cabinetX + cabinetW - 2, cabinetY + drawerH * i);
    g.stroke({ color: accent, width: 0.8 });
  }

  // drawer handles (small rounded rects)
  const handleW = cabinetW * 0.3;
  const handleH = 3;
  for (let i = 0; i < 3; i++) {
    g.roundRect(cx - handleW / 2, cabinetY + drawerH * i + drawerH / 2 - handleH / 2, handleW, handleH, 1.5);
    g.fill({ color: accent });
  }

  // small tabs on the right side
  g.rect(cabinetX + cabinetW - 1, cabinetY + drawerH * 0.2, s * 0.08, drawerH * 0.6);
  g.fill({ color: accent });
  g.rect(cabinetX + cabinetW - 1, cabinetY + drawerH * 1.2, s * 0.08, drawerH * 0.6);
  g.fill({ color: 0x6ee7b7 });
}

function drawStatusStationIcon(g: Graphics, accent: number, cx: number, cy: number, s: number): void {
  // vertical pole
  g.rect(cx - s * 0.03, cy - s * 0.35, s * 0.06, s * 0.7);
  g.fill({ color: 0x9ca3af });

  // top sign arm (left)
  g.roundRect(cx - s * 0.38, cy - s * 0.35, s * 0.35, s * 0.12, 2);
  g.fill({ color: accent });
  g.roundRect(cx - s * 0.38, cy - s * 0.35, s * 0.35, s * 0.12, 2);
  g.stroke({ color: 0x4b5563, width: 0.8 });

  // top sign arm (right)
  g.roundRect(cx + s * 0.03, cy - s * 0.35, s * 0.35, s * 0.12, 2);
  g.fill({ color: 0x9ca3af });
  g.roundRect(cx + s * 0.03, cy - s * 0.35, s * 0.35, s * 0.12, 2);
  g.stroke({ color: 0x4b5563, width: 0.8 });

  // bottom sign arm (left)
  g.roundRect(cx - s * 0.3, cy - s * 0.12, s * 0.27, s * 0.1, 2);
  g.fill({ color: 0xd1d5db });
  g.roundRect(cx - s * 0.3, cy - s * 0.12, s * 0.27, s * 0.1, 2);
  g.stroke({ color: 0x4b5563, width: 0.8 });

  // bottom sign arm (right)
  g.roundRect(cx + s * 0.03, cy - s * 0.12, s * 0.27, s * 0.1, 2);
  g.fill({ color: 0xd1d5db });
  g.roundRect(cx + s * 0.03, cy - s * 0.12, s * 0.27, s * 0.1, 2);
  g.stroke({ color: 0x4b5563, width: 0.8 });

  // direction arrows on signs
  // left arrow on top-left sign
  g.moveTo(cx - s * 0.32, cy - s * 0.29);
  g.lineTo(cx - s * 0.25, cy - s * 0.33);
  g.lineTo(cx - s * 0.25, cy - s * 0.25);
  g.closePath();
  g.fill({ color: 0xffffff });

  // right arrow on top-right sign
  g.moveTo(cx + s * 0.32, cy - s * 0.29);
  g.lineTo(cx + s * 0.25, cy - s * 0.33);
  g.lineTo(cx + s * 0.25, cy - s * 0.25);
  g.closePath();
  g.fill({ color: 0xffffff });
}

// ── icon dispatch ────────────────────────────────────────────────────

const ICON_DRAWERS: Record<string, (g: Graphics, accent: number, cx: number, cy: number, s: number) => void> = {
  home: drawHomeIcon,
  video_workstation: drawVideoWorkstationIcon,
  artifact_box: drawArtifactBoxIcon,
  tiktok_station: drawTiktokStationIcon,
  material_library: drawMaterialLibraryIcon,
  status_station: drawStatusStationIcon,
};

// ── main class ───────────────────────────────────────────────────────

export class WorkstationNode {
  static draw(node: WorldNodeData): Container {
    const container = new Container();
    const accent = NODE_ACCENT_COLORS[node.type] ?? 0x6b7280;
    const { width: w, height: h } = node.size;

    // ── background card ──
    const bg = new Graphics();
    bg.roundRect(-w / 2, -h / 2, w, h, NODE_BORDER_RADIUS);
    bg.fill({ color: 0xffffff });
    bg.roundRect(-w / 2, -h / 2, w, h, NODE_BORDER_RADIUS);
    bg.stroke({ color: 0xe5e7eb, width: 1.5 });
    container.addChild(bg);

    // ── accent side stripe (left edge) ──
    const stripe = new Graphics();
    stripe.roundRect(-w / 2, -h / 2, 4, h, NODE_BORDER_RADIUS);
    stripe.fill({ color: accent });
    container.addChild(stripe);

    // ── type-specific icon ──
    const iconGfx = new Graphics();
    const drawer = ICON_DRAWERS[node.type];
    if (drawer) {
      // icon area: centered horizontally, vertically shifted up to leave room for label
      const iconCx = 0;
      const iconCy = -6;
      const iconSize = Math.min(w, h) * 0.55;
      drawer(iconGfx, accent, iconCx, iconCy, iconSize);
    }
    container.addChild(iconGfx);

    // ── name label ──
    const label = new Text({
      text: node.name,
      style: {
        fill: 0x374151,
        fontSize: 11,
        fontFamily: "sans-serif",
        fontWeight: "500",
      },
    });
    label.anchor.set(0.5);
    label.y = h / 2 - 16;
    container.addChild(label);

    // ── status light (top-right) ──
    const light = new Graphics();
    light.circle(w / 2 - 10, -h / 2 + 10, 3);
    light.fill({ color: 0x10b981 });
    container.addChild(light);

    // ── interactivity ──
    container.eventMode = "static";
    container.cursor = "pointer";
    container.label = node.id;

    container.x = node.position.x;
    container.y = node.position.y;

    return container;
  }
}
