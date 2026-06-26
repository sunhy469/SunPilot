import { Container, Graphics, Text, Ticker } from "pixi.js";
import type { WorldNodeData, WorldEdgeData } from "../types";

// Task 11 (§9.3.4): particle effects.
//  - working/publishing beings emit rising sparks above their head
//  - sleeping beings emit floating "z" characters
//  - roads carry flowing light points indicating data flow

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
}

const WORKING_PARTICLE_INTERVAL = 18; // frames between spark spawns per working being
const ZZZ_INTERVAL = 55;
const MAX_PARTICLES = 90;
// Being anchor is at the feet (y=0); head sits around y=-55, so particles
// spawn just above the head.
const HEAD_OFFSET_Y = -58;

export class ParticleLayer {
  readonly container: Container;

  private particles: Particle[] = [];
  private roadLights: RoadLight[] = [];
  private spawnCounters = new Map<string, number>();
  private callback: ((ticker: Ticker) => void) | null = null;

  constructor(
    private readonly ticker: Ticker,
    private readonly getBeings: () => BeingSnapshot[],
  ) {
    this.container = new Container();
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
      const gfx = new Graphics();
      gfx.circle(0, 0, 2.2);
      gfx.fill({ color: 0xfde68a, alpha: 0.9 });
      this.container.addChild(gfx);
      this.roadLights.push({
        gfx,
        fromX: from.position.x,
        fromY: from.position.y,
        toX: to.position.x,
        toY: to.position.y,
        progress: Math.random(),
        speed: 0.004 + Math.random() * 0.003,
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
  }

  private spawnWorkingSpark(x: number, y: number) {
    const palette = [0xfbbf24, 0xf59e0b, 0xfde68a];
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
    for (const p of this.particles) p.gfx.destroy();
    this.particles = [];
    for (const rl of this.roadLights) rl.gfx.destroy();
    this.roadLights = [];
    this.spawnCounters.clear();
    this.container.destroy({ children: false });
  }
}
