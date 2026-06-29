import { Container, Graphics, Text, Ticker } from "pixi.js";
import type { WorldNodeData, WorldEdgeData } from "../types";
import { ROAD_TYPE_COLORS, type RoadType } from "../constants";

// Task 11 (§9.3.4): particle effects.
//  - working/publishing beings emit rising sparks above their head
//  - sleeping beings emit floating "z" characters
//  - roads carry flowing light points indicating data flow
//
// Batch 5 Phase 2 (§3.4 + §3.6):
//  - road flow lights colored by road type (cyan/purple/amber)
//  - ambient particles: very sparse, slow-rising dots for "data space" depth

interface BeingSnapshot {
  id: string;
  x: number;
  y: number;
  status: string;
}

interface Particle {
  gfx: Graphics | Text;
  vx: number;
  vy: number;
  life: number; // remaining frames (60fps-normalized)
  maxLife: number;
}

interface RoadLight {
  gfx: Graphics;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  progress: number; // 0..1 along the edge
  speed: number;
  color: number;
}

interface AmbientParticle {
  gfx: Graphics;
  x: number;
  y: number;
  vy: number;
  alpha: number;
  alphaPhase: number;
}

const WORKING_PARTICLE_INTERVAL = 18; // frames between spark spawns per working being
const ZZZ_INTERVAL = 55;
const MAX_PARTICLES = 90;
const MAX_AMBIENT = 40;
// Batch 5 Phase 4: geometric core floats at y=-28 with radius 16, so the top
// is at y=-44. Sparks spawn just above the core.
const HEAD_OFFSET_Y = -48;

// Node types that indicate each road type (mirrors RoadLayer's inference).
const PRODUCT_NODE_TYPES = new Set([
  "video_workstation",
  "artifact_box",
  "tiktok_station",
]);
const DATA_NODE_TYPES = new Set(["material_library"]);

function inferRoadType(from: WorldNodeData, to: WorldNodeData): RoadType {
  if (DATA_NODE_TYPES.has(from.type) || DATA_NODE_TYPES.has(to.type)) return "data";
  if (PRODUCT_NODE_TYPES.has(from.type) || PRODUCT_NODE_TYPES.has(to.type)) return "product";
  return "control";
}

export class ParticleLayer {
  readonly container: Container;

  private particles: Particle[] = [];
  private roadLights: RoadLight[] = [];
  private ambientParticles: AmbientParticle[] = [];
  private spawnCounters = new Map<string, number>();
  private callback: ((ticker: Ticker) => void) | null = null;
  private ambientCallback: ((ticker: Ticker) => void) | null = null;
  private _bounds: { width: number; height: number } = { width: 1200, height: 800 };

  constructor(
    private readonly ticker: Ticker,
    private readonly getBeings: () => BeingSnapshot[],
  ) {
    this.container = new Container();
  }

  /** Set the canvas bounds for ambient particle distribution. */
  setBounds(width: number, height: number) {
    this._bounds = { width, height };
    this.initAmbient();
  }

  /** (Re)build the road flow lights from the current node/edge set. */
  setRoads(nodes: WorldNodeData[], edges: WorldEdgeData[]) {
    for (const rl of this.roadLights) rl.gfx.destroy();
    this.roadLights = [];

    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    for (const edge of edges) {
      const from = nodeMap.get(edge.fromNodeId);
      const to = nodeMap.get(edge.toNodeId);
      if (!from || !to) continue;
      const type = inferRoadType(from, to);
      const color = ROAD_TYPE_COLORS[type];
      const gfx = new Graphics();
      gfx.circle(0, 0, 2.5);
      gfx.fill({ color, alpha: 0.9 });
      this.container.addChild(gfx);
      this.roadLights.push({
        gfx,
        fromX: from.position.x,
        fromY: from.position.y,
        toX: to.position.x,
        toY: to.position.y,
        progress: Math.random(),
        speed: 0.004 + Math.random() * 0.003,
        color,
      });
    }
  }

  /** Initialize ambient particles (sparse, slow-rising dots). */
  private initAmbient() {
    for (const ap of this.ambientParticles) ap.gfx.destroy();
    this.ambientParticles = [];

    const count = Math.min(MAX_AMBIENT, Math.floor((this._bounds.width * this._bounds.height) / 30000));
    for (let i = 0; i < count; i++) {
      const gfx = new Graphics();
      gfx.circle(0, 0, 0.8 + Math.random() * 0.6);
      gfx.fill({ color: 0x6b7c99, alpha: 0.2 + Math.random() * 0.15 });
      this.container.addChildAt(gfx, 0);
      this.ambientParticles.push({
        gfx,
        x: Math.random() * this._bounds.width,
        y: Math.random() * this._bounds.height,
        vy: -(0.08 + Math.random() * 0.06),
        alpha: 0.15 + Math.random() * 0.15,
        alphaPhase: Math.random() * Math.PI * 2,
      });
    }
  }

  start() {
    if (this.callback) return;
    this.callback = (ticker) => this.tick(ticker);
    this.ticker.add(this.callback);
  }

  private tick(ticker: Ticker) {
    // Normalize to ~60fps frame units so speeds are consistent across refresh rates.
    const dt = ticker.deltaMS / 16.6667;
    const beings = this.getBeings();

    // Spawn particles based on each being's status.
    for (const b of beings) {
      const counter = (this.spawnCounters.get(b.id) ?? 0) + dt;
      this.spawnCounters.set(b.id, counter);
      const isWorking = b.status === "working" || b.status === "publishing";
      if (isWorking && counter >= WORKING_PARTICLE_INTERVAL && this.particles.length < MAX_PARTICLES) {
        this.spawnCounters.set(b.id, 0);
        this.spawnWorkingSpark(b.x, b.y);
      } else if (b.status === "sleeping" && counter >= ZZZ_INTERVAL && this.particles.length < MAX_PARTICLES) {
        this.spawnCounters.set(b.id, 0);
        this.spawnZzz(b.x, b.y);
      }
    }

    // Update + cull particles.
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.gfx.destroy();
        this.particles.splice(i, 1);
        continue;
      }
      p.gfx.x += p.vx * dt;
      p.gfx.y += p.vy * dt;
      p.gfx.alpha = Math.max(0, p.life / p.maxLife);
    }

    // Advance road flow lights along their edges.
    for (const rl of this.roadLights) {
      rl.progress += rl.speed * dt;
      if (rl.progress > 1) rl.progress -= 1;
      rl.gfx.x = rl.fromX + (rl.toX - rl.fromX) * rl.progress;
      rl.gfx.y = rl.fromY + (rl.toY - rl.fromY) * rl.progress;
      rl.gfx.alpha = 0.35 + Math.sin(rl.progress * Math.PI) * 0.5;
    }

    // Advance ambient particles (slow upward drift + alpha pulsing).
    for (const ap of this.ambientParticles) {
      ap.y += ap.vy * dt;
      ap.alphaPhase += 0.02 * dt;
      if (ap.y < -10) {
        ap.y = this._bounds.height + 10;
        ap.x = Math.random() * this._bounds.width;
      }
      ap.gfx.x = ap.x;
      ap.gfx.y = ap.y;
      ap.gfx.alpha = ap.alpha + Math.sin(ap.alphaPhase) * 0.05;
    }
  }

  private spawnWorkingSpark(x: number, y: number) {
    // Batch 5 Phase 4: cyan sparks match the geometric core's working color.
    const palette = [0x06b6d4, 0x22d3ee, 0x67e8f9];
    const color = palette[Math.floor(Math.random() * palette.length)]!;
    const gfx = new Graphics();
    gfx.circle(0, 0, 1.6 + Math.random() * 1.2);
    gfx.fill({ color });
    gfx.x = x + (Math.random() - 0.5) * 16;
    gfx.y = y + HEAD_OFFSET_Y;
    this.container.addChild(gfx);
    const maxLife = 40 + Math.random() * 20;
    this.particles.push({
      gfx,
      vx: (Math.random() - 0.5) * 0.4,
      vy: -0.6 - Math.random() * 0.4,
      life: maxLife,
      maxLife,
    });
  }

  private spawnZzz(x: number, y: number) {
    const txt = new Text({
      text: "z",
      style: {
        fill: 0x93c5fd,
        fontSize: 11,
        fontFamily: "sans-serif",
        fontWeight: "700",
      },
    });
    txt.anchor.set(0.5);
    txt.x = x + 14;
    txt.y = y + HEAD_OFFSET_Y;
    this.container.addChild(txt);
    const maxLife = 70;
    this.particles.push({
      gfx: txt,
      vx: 0.25,
      vy: -0.45,
      life: maxLife,
      maxLife,
    });
  }

  destroy() {
    if (this.callback) {
      this.ticker.remove(this.callback);
      this.callback = null;
    }
    if (this.ambientCallback) {
      this.ticker.remove(this.ambientCallback);
      this.ambientCallback = null;
    }
    for (const p of this.particles) p.gfx.destroy();
    this.particles = [];
    for (const rl of this.roadLights) rl.gfx.destroy();
    this.roadLights = [];
    for (const ap of this.ambientParticles) ap.gfx.destroy();
    this.ambientParticles = [];
    this.spawnCounters.clear();
    this.container.destroy({ children: false });
  }
}
