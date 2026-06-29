import { Container, Graphics, Sprite, Ticker, Text, Texture } from "pixi.js";
import { NODE_BORDER_RADIUS, getCurrentWorldTheme } from "../constants";
import type { WorldNodeData } from "../types";

export const NODE_ACCENT_COLORS: Record<string, number> = {
  home: 0xf59e0b,
  video_workstation: 0x2563eb,
  artifact_box: 0x8b5cf6,
  tiktok_station: 0x06b6d4,
  material_library: 0x10b981,
  status_station: 0x6b7280,
};

// ── status indicator color mapping ────────────────────────────────────
export type NodeStatus = "active" | "busy" | "error" | "idle";

const NODE_STATUS_COLORS: Record<NodeStatus, number> = {
  active: 0x10b981, // green
  busy: 0xf59e0b,   // yellow
  error: 0xef4444,  // red
  idle: 0x9ca3af,   // gray
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

export const ICON_DRAWERS: Record<string, (g: Graphics, accent: number, cx: number, cy: number, s: number) => void> = {
  home: drawHomeIcon,
  video_workstation: drawVideoWorkstationIcon,
  artifact_box: drawArtifactBoxIcon,
  tiktok_station: drawTiktokStationIcon,
  material_library: drawMaterialLibraryIcon,
  status_station: drawStatusStationIcon,
};

// ── texture cache ────────────────────────────────────────────────────

/** Reference icon size used when pre-rendering icons into textures. */
export const ICON_TEXTURE_REFERENCE_SIZE = 64;

/** Maps a workstation type → pre-rendered icon Texture. */
export type IconTextureCache = Map<string, Texture>;

/**
 * Pre-render every workstation icon type into a Texture once. The returned
 * cache is reused across redraws so drawWorld() no longer rebuilds Graphics
 * for icons on every frame. Callers must destroy the textures when the app
 * is torn down (see WorldApp.destroy).
 */
export function buildIconTextureCache(
  renderer: { generateTexture: (target: Graphics | Container) => Texture },
): IconTextureCache {
  const cache: IconTextureCache = new Map();
  for (const [type, drawer] of Object.entries(ICON_DRAWERS)) {
    const accent = NODE_ACCENT_COLORS[type] ?? 0x6b7280;
    const g = new Graphics();
    // Render centered at the origin so the Sprite can be anchored at 0.5.
    drawer(g, accent, 0, 0, ICON_TEXTURE_REFERENCE_SIZE);
    const texture = renderer.generateTexture(g);
    g.destroy();
    cache.set(type, texture);
  }
  return cache;
}

// ── hover/pulse animation constants ──────────────────────────────────
const HOVER_LIFT_PX = 4;           // card lifts up this many px on hover
const HOVER_LERP_SPEED = 0.18;     // 0..1 lerp factor per frame
const PULSE_SPEED = 0.08;          // radians per frame
const PULSE_AMPLITUDE = 0.18;      // scale amplitude
const SHADOW_BASE_ALPHA = 0.12;
const SHADOW_HOVER_ALPHA = 0.22;

// ── main class ───────────────────────────────────────────────────────

export class WorkstationNode {
  /**
   * Render a workstation node as a Container. The returned container is
   * positioned at node.position and self-manages hover lift, status-light
   * pulse, and border highlight animations via Ticker.shared. The ticker
   * callback is cleaned up automatically when the container is destroyed
   * (via the PixiJS "destroyed" event).
   *
   * @param node        Node data (type, position, size, name).
   * @param iconTextures Optional pre-rendered icon texture cache (§9.2.1).
   * @param status      Status indicator color. Defaults to "active" (green).
   */
  static draw(node: WorldNodeData, iconTextures?: IconTextureCache, status: NodeStatus = "active"): Container {
    const container = new Container();
    const accent = NODE_ACCENT_COLORS[node.type] ?? 0x6b7280;
    const statusColor = NODE_STATUS_COLORS[status] ?? NODE_STATUS_COLORS.active;
    const { width: w, height: h } = node.size;
    // Task 13 (§9.5.4): card bg + label text color follow the active theme.
    const theme = getCurrentWorldTheme();

    // Batch 5 Phase 2 (§3.3): hexagon shape — flat-top regular polygon.
    const hexRadius = Math.min(w, h) / 2 * 0.9;
    const hexRotation = Math.PI / 6; // flat-top

    // ── Drop shadow (stays at base, does NOT lift with the card) ──
    const shadow = new Graphics();
    shadow.regularPoly(0, 3, hexRadius, 6, hexRotation);
    shadow.fill({ color: 0x000000, alpha: SHADOW_BASE_ALPHA });
    container.addChild(shadow);

    // ── Card container (lifts on hover) ──
    const card = new Container();
    container.addChild(card);

    // ── Background hexagon ──
    const bg = new Graphics();
    bg.regularPoly(0, 0, hexRadius, 6, hexRotation);
    bg.fill({ color: theme.nodeBg });
    card.addChild(bg);

    // ── Icon glow (soft radial halo behind icon) ──
    const iconCx = 0;
    const iconCy = -6;
    const iconSize = Math.min(w, h) * 0.55;
    const glow = new Graphics();
    glow.circle(iconCx, iconCy, iconSize * 0.55);
    glow.fill({ color: accent, alpha: 0.1 });
    card.addChild(glow);

    // ── Type-specific icon (cached Sprite or Graphics fallback) ──
    const cachedTexture = iconTextures?.get(node.type);
    if (cachedTexture) {
      const iconSprite = new Sprite(cachedTexture);
      iconSprite.anchor.set(0.5);
      iconSprite.x = iconCx;
      iconSprite.y = iconCy;
      iconSprite.scale.set(iconSize / ICON_TEXTURE_REFERENCE_SIZE);
      card.addChild(iconSprite);
    } else {
      const iconGfx = new Graphics();
      const drawer = ICON_DRAWERS[node.type];
      if (drawer) {
        drawer(iconGfx, accent, iconCx, iconCy, iconSize);
      }
      card.addChild(iconGfx);
    }

    // ── Name label (13px, font-weight 600, letter-spacing 0.5px) ──
    const label = new Text({
      text: node.name,
      style: {
        fill: theme.textColor,
        fontSize: 13,
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
        fontWeight: "600",
        letterSpacing: 0.5,
      },
    });
    label.anchor.set(0.5);
    label.y = h / 2 - 14;
    card.addChild(label);

    // ── Status ring glow (Batch 5 Phase 2 §3.3) ──
    // Replaces the top-right dot with a full-ring glow line around the
    // hexagon. Active nodes have a breathing alpha animation.
    const statusRing = new Graphics();
    statusRing.regularPoly(0, 0, hexRadius + 2, 6, hexRotation);
    statusRing.stroke({ color: statusColor, width: 2, alpha: 0.6 });
    card.addChild(statusRing);

    // ── Accent border ──
    const border = new Graphics();
    border.regularPoly(0, 0, hexRadius, 6, hexRotation);
    border.stroke({ color: theme.nodeBorder, width: 1.5 });
    card.addChild(border);

    const hoverBorder = new Graphics();
    hoverBorder.regularPoly(0, 0, hexRadius, 6, hexRotation);
    hoverBorder.stroke({ color: accent, width: 2 });
    hoverBorder.alpha = 0;
    card.addChild(hoverBorder);

    // ── Data bar indicator (Batch 5 Phase 2 §3.3) ──
    // Small bar chart below the hexagon — decorative "data throughput" bars.
    const dataBarY = hexRadius + 6;
    const dataBarCount = 5;
    const dataBarW = 4;
    const dataBarGap = 2;
    const dataBarMaxH = 10;
    const dataBars: Graphics[] = [];
    const dataBarContainer = new Container();
    dataBarContainer.y = dataBarY;
    card.addChild(dataBarContainer);
    const totalDataBarW = dataBarCount * dataBarW + (dataBarCount - 1) * dataBarGap;
    for (let i = 0; i < dataBarCount; i++) {
      const bar = new Graphics();
      const bh = 3 + Math.random() * (dataBarMaxH - 3);
      bar.rect(
        -totalDataBarW / 2 + i * (dataBarW + dataBarGap),
        -bh,
        dataBarW,
        bh,
      );
      bar.fill({ color: accent, alpha: 0.5 });
      dataBarContainer.addChild(bar);
      dataBars.push(bar);
    }

    // ── Hover + pulse animation (self-cleaning via "destroyed" event) ──
    let hoverAmount = 0;       // current animated hover (0..1)
    let targetHover = 0;       // target hover (0 or 1)
    let pulseFrame = 0;

    const animate = () => {
      // Smooth lerp toward target hover
      hoverAmount += (targetHover - hoverAmount) * HOVER_LERP_SPEED;
      if (Math.abs(targetHover - hoverAmount) < 0.001) hoverAmount = targetHover;

      // Lift the card (shadow stays put for a 3D effect)
      card.y = -HOVER_LIFT_PX * hoverAmount;
      shadow.alpha = SHADOW_BASE_ALPHA + (SHADOW_HOVER_ALPHA - SHADOW_BASE_ALPHA) * hoverAmount;
      shadow.y = 1 + 2 * hoverAmount;

      // Border crossfade
      border.alpha = 1 - hoverAmount * 0.5;
      hoverBorder.alpha = hoverAmount;

      // Status ring breathing glow (Batch 5 Phase 2 §3.3)
      pulseFrame++;
      const pulse = Math.sin(pulseFrame * PULSE_SPEED);
      statusRing.alpha = 0.4 + pulse * 0.3;
      statusRing.scale.set(1 + pulse * 0.02);
    };
    Ticker.shared.add(animate);
    container.on("destroyed", () => {
      Ticker.shared.remove(animate);
    });

    // ── Interactivity ──
    container.eventMode = "static";
    container.cursor = "pointer";
    container.label = node.id;

    container.on("pointerover", () => { targetHover = 1; });
    container.on("pointerout", () => { targetHover = 0; });

    container.x = node.position.x;
    container.y = node.position.y;

    return container;
  }
}
