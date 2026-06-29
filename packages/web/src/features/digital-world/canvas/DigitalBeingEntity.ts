import { Container, Graphics, Ticker } from "pixi.js";

// ── Icosahedron geometry ───────────────────────────────────────────
// 12 vertices of a regular icosahedron defined via the golden ratio.
const PHI = (1 + Math.sqrt(5)) / 2;

const RAW_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 1, PHI], [0, -1, PHI], [0, 1, -PHI], [0, -1, -PHI],
  [1, PHI, 0], [-1, PHI, 0], [1, -PHI, 0], [-1, -PHI, 0],
  [PHI, 0, 1], [-PHI, 0, 1], [PHI, 0, -1], [-PHI, 0, -1],
];

// Normalize to unit sphere so every vertex sits at distance 1 from origin.
const VERTS: ReadonlyArray<[number, number, number]> = RAW_VERTICES.map(([x, y, z]) => {
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len];
});

// 30 edges — pairs of vertex indices whose unit-normalized positions are
// exactly 1 apart (the edge length of a unit-circumradius icosahedron).
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [0, 4], [0, 5], [0, 8], [0, 9],
  [1, 6], [1, 7], [1, 8], [1, 9],
  [2, 3], [2, 4], [2, 5], [2, 10], [2, 11],
  [3, 6], [3, 7], [3, 10], [3, 11],
  [4, 5], [4, 8], [4, 10],
  [5, 9], [5, 11],
  [6, 7], [6, 8], [6, 10],
  [7, 9], [7, 11],
  [8, 10], [9, 11],
];

// ── Visual constants ───────────────────────────────────────────────
const CORE_RADIUS = 16;
const CORE_FLOAT_Y = -28;
const RING_RADIUS_X = 26;
const RING_RADIUS_Y = 7;
const RING_POINT_COUNT = 6;
const SHADOW_ALPHA = 0.2;
const PERSPECTIVE = 0.04;

// ── Status-driven parameters ──────────────────────────────────────
type BeingStatus = "idle" | "moving" | "working" | "waiting" | "sleeping" | "error" | "publishing";
type FacingDirection = "left" | "right" | "front";

function targetRotSpeed(status: BeingStatus): number {
  switch (status) {
    case "working":
    case "publishing":
      return 0.035;
    case "sleeping":
      return 0;
    case "error":
      return 0.008;
    default:
      return 0.01;
  }
}

function targetRingSpeed(status: BeingStatus): number {
  switch (status) {
    case "working":
    case "publishing":
      return 0.04;
    case "sleeping":
      return 0;
    default:
      return 0.015;
  }
}

function targetCoreColor(status: BeingStatus): number {
  switch (status) {
    case "working":
    case "publishing":
      return 0x06b6d4; // cyan
    case "error":
      return 0xef4444; // red
    case "sleeping":
      return 0x4b5563; // dim gray
    case "waiting":
      return 0xfbbf24; // amber
    default:
      return 0xffffff; // white (idle, moving)
  }
}

function targetAlpha(status: BeingStatus): number {
  return status === "sleeping" ? 0.3 : 1;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

interface TrailDot {
  spawnX: number;
  spawnY: number;
  life: number;
  maxLife: number;
}

export class DigitalBeingEntity {
  readonly container: Container;

  private shadowLayer!: Graphics;
  private coreLayer!: Graphics;
  private ringLayer!: Graphics;
  private trailLayer!: Graphics;
  private progressLayer!: Graphics;

  private _status: BeingStatus = "idle";
  private _facing: FacingDirection = "front";
  private _workingProgress = 0;
  private _shadowZoom = 1;

  private _animCallback: ((ticker: Ticker) => void) | null = null;
  private _rotY = 0;
  private _rotX = 0.35;
  private _ringPhase = 0;

  private _curRotSpeed = 0.01;
  private _curRingSpeed = 0.015;
  private _curCoreColor = 0xffffff;
  private _curAlpha = 1;

  private _errorBlinkPhase = 0;

  private _trail: TrailDot[] = [];
  private _trailSpawnCounter = 0;

  private _destroyed = false;

  constructor(private readonly ticker: Ticker) {
    this.container = new Container();
    this.draw();
    this.startAnimation();
  }

  setPosition(x: number, y: number) {
    this.container.x = x;
    this.container.y = y;
    this.redrawShadow();
  }

  setFacing(direction: FacingDirection) {
    this._facing = direction;
  }

  setStatus(status: string) {
    this._status = status as BeingStatus;
  }

  setWorkingProgress(progress: number) {
    this._workingProgress = Math.max(0, Math.min(1, progress));
    this.redrawProgress();
  }

  setMouseWorldPosition(_x: number | null, _y: number | null) {
    // No-op: geometric core has no eyes. Kept for API compatibility.
  }

  setShadowScale(zoom: number) {
    this._shadowZoom = Math.max(0.4, Math.min(2.0, zoom));
    this.redrawShadow();
  }

  playIdle() { /* no-op: continuous animation handles all states */ }
  playMove() { /* no-op */ }
  playSleep() { /* no-op */ }
  playWorking() { /* no-op */ }

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stopAnimation();
    this.container.destroy({ children: true });
  }

  // ── Animation ───────────────────────────────────────────────────

  private startAnimation() {
    this._animCallback = (ticker) => this.tick(ticker);
    this.ticker.add(this._animCallback);
  }

  private stopAnimation() {
    if (this._animCallback) {
      this.ticker.remove(this._animCallback);
      this._animCallback = null;
    }
  }

  private tick(ticker: Ticker) {
    if (this._destroyed || this.container.destroyed) return;
    const dt = ticker.deltaMS / 16.6667;

    const lerp = 0.06;
    this._curRotSpeed += (targetRotSpeed(this._status) - this._curRotSpeed) * lerp;
    this._curRingSpeed += (targetRingSpeed(this._status) - this._curRingSpeed) * lerp;
    this._curCoreColor = lerpColor(this._curCoreColor, targetCoreColor(this._status), lerp);
    this._curAlpha += (targetAlpha(this._status) - this._curAlpha) * lerp;

    this._rotY += this._curRotSpeed * dt;
    this._ringPhase += this._curRingSpeed * dt;

    if (this._status === "error") {
      this._errorBlinkPhase += 0.12 * dt;
    }

    if (this._status === "moving") {
      this._trailSpawnCounter += dt;
      if (this._trailSpawnCounter >= 3) {
        this._trailSpawnCounter = 0;
        this._trail.push({
          spawnX: this.container.x,
          spawnY: this.container.y,
          life: 20,
          maxLife: 20,
        });
      }
    }
    for (let i = this._trail.length - 1; i >= 0; i--) {
      this._trail[i]!.life -= dt;
      if (this._trail[i]!.life <= 0) this._trail.splice(i, 1);
    }

    this.redrawCore();
    this.redrawRing();
    this.redrawTrail();
  }

  // ── Drawing ─────────────────────────────────────────────────────

  private draw() {
    this.drawShadow();
    this.trailLayer = new Graphics();
    this.coreLayer = new Graphics();
    this.ringLayer = new Graphics();
    this.container.addChild(this.trailLayer);
    this.container.addChild(this.ringLayer);
    this.container.addChild(this.coreLayer);
    this.drawProgress();
  }

  private drawShadow() {
    this.shadowLayer = new Graphics();
    this.container.addChildAt(this.shadowLayer, 0);
    this.redrawShadow();
  }

  private redrawShadow() {
    if (!this.shadowLayer || this.shadowLayer.destroyed) return;
    this.shadowLayer.clear();
    const rx = 18 * (0.85 + this._shadowZoom * 0.15);
    const ry = 4 * (0.85 + this._shadowZoom * 0.15);
    this.shadowLayer.ellipse(0, 2, rx, ry);
    this.shadowLayer.fill({ color: 0x000000, alpha: SHADOW_ALPHA });
  }

  private rotateVertex(v: [number, number, number]): [number, number, number] {
    const [x, y, z] = v;
    const cosY = Math.cos(this._rotY), sinY = Math.sin(this._rotY);
    const x1 = x * cosY + z * sinY;
    const z1 = -x * sinY + z * cosY;
    const cosX = Math.cos(this._rotX), sinX = Math.sin(this._rotX);
    const y2 = y * cosX - z1 * sinX;
    const z2 = y * sinX + z1 * cosX;
    return [x1, y2, z2];
  }

  private project(v: [number, number, number]): [number, number, number] {
    const denom = 1 + v[2] * PERSPECTIVE;
    return [(v[0] * CORE_RADIUS) / denom, (v[1] * CORE_RADIUS) / denom, v[2]];
  }

  private effectiveAlpha(): number {
    let alpha = this._curAlpha;
    if (this._status === "error") {
      alpha *= 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this._errorBlinkPhase));
    }
    return alpha;
  }

  private redrawCore() {
    if (!this.coreLayer || this.coreLayer.destroyed) return;
    this.coreLayer.clear();
    this.coreLayer.y = CORE_FLOAT_Y;

    const alpha = this.effectiveAlpha();
    const projected = VERTS.map((v) => this.project(this.rotateVertex(v)));

    this.coreLayer.setStrokeStyle({
      width: 1.2,
      color: this._curCoreColor,
      cap: "round",
      join: "round",
    });
    for (const [a, b] of EDGES) {
      const pa = projected[a]!;
      const pb = projected[b]!;
      const avgZ = (pa[2] + pb[2]) / 2;
      const edgeAlpha = alpha * (0.35 + 0.5 * ((avgZ + 1) / 2));
      this.coreLayer.moveTo(pa[0], pa[1]);
      this.coreLayer.lineTo(pb[0], pb[1]);
      this.coreLayer.stroke({ alpha: edgeAlpha });
    }

    for (const p of projected) {
      const dotAlpha = alpha * (0.4 + 0.5 * ((p[2] + 1) / 2));
      this.coreLayer.circle(p[0], p[1], 1.2);
      this.coreLayer.fill({ color: this._curCoreColor, alpha: dotAlpha });
    }
  }

  private redrawRing() {
    if (!this.ringLayer || this.ringLayer.destroyed) return;
    this.ringLayer.clear();
    this.ringLayer.y = CORE_FLOAT_Y;

    const alpha = this.effectiveAlpha();

    this.ringLayer.setStrokeStyle({
      width: 1,
      color: this._curCoreColor,
      alpha: alpha * 0.2,
    });
    this.ringLayer.ellipse(0, 0, RING_RADIUS_X, RING_RADIUS_Y);
    this.ringLayer.stroke();

    for (let i = 0; i < RING_POINT_COUNT; i++) {
      const phase = (this._ringPhase + i / RING_POINT_COUNT) % 1;
      const angle = phase * Math.PI * 2;
      const px = Math.cos(angle) * RING_RADIUS_X;
      const py = Math.sin(angle) * RING_RADIUS_Y;
      const depthAlpha = py > 0 ? 0.9 : 0.4;
      this.ringLayer.circle(px, py, 2);
      this.ringLayer.fill({ color: this._curCoreColor, alpha: alpha * depthAlpha });
    }
  }

  private redrawTrail() {
    if (!this.trailLayer || this.trailLayer.destroyed) return;
    this.trailLayer.clear();
    const scaleX = this.container.scale.x || 1;
    const scaleY = this.container.scale.y || 1;
    for (const t of this._trail) {
      const lifeRatio = t.life / t.maxLife;
      const localX = (t.spawnX - this.container.x) / scaleX;
      const localY = (t.spawnY - this.container.y) / scaleY + CORE_FLOAT_Y;
      this.trailLayer.circle(localX, localY, 2 * lifeRatio);
      this.trailLayer.fill({ color: this._curCoreColor, alpha: lifeRatio * 0.4 });
    }
  }

  private drawProgress() {
    this.progressLayer = new Graphics();
    this.progressLayer.visible = false;
    this.container.addChild(this.progressLayer);
  }

  private redrawProgress() {
    if (!this.progressLayer || this.progressLayer.destroyed) return;
    this.progressLayer.clear();

    if (
      (this._status !== "working" && this._status !== "publishing") ||
      this._workingProgress <= 0
    ) {
      this.progressLayer.visible = false;
      return;
    }

    this.progressLayer.visible = true;

    const barWidth = 36;
    const barHeight = 3;
    const barY = CORE_FLOAT_Y - CORE_RADIUS - 8;
    const barX = -barWidth / 2;

    this.progressLayer.roundRect(barX, barY, barWidth, barHeight, 1.5);
    this.progressLayer.fill({ color: 0x1e3a5f });

    const fillWidth = Math.max(barHeight, barWidth * this._workingProgress);
    this.progressLayer.roundRect(barX, barY, fillWidth, barHeight, 1.5);
    this.progressLayer.fill({ color: 0x06b6d4 });
  }
}
