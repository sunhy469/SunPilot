import type { Ticker } from "pixi.js";
import type { WorldNodeData } from "../types";
import type { DigitalBeingEntity } from "../canvas/DigitalBeingEntity";
import type { StatusBubbleLayer } from "../canvas/StatusBubbleLayer";

const MOVE_SPEED = 120; // pixels per second

export class RouteAnimator {
  private tickerCallback?: (ticker: Ticker) => void;
  private currentSegment = 0;
  private segmentProgress = 0;
  private routePositions: { x: number; y: number }[] = [];
  private running = false;

  private onNodeReachedCb?: (nodeId: string, index: number) => void;
  private onCompleteCb?: () => void;

  constructor(
    private readonly ticker: Ticker,
    private readonly being: DigitalBeingEntity,
    private readonly statusBubble: StatusBubbleLayer,
    private readonly routeNodeIds: string[],
    private readonly nodes: WorldNodeData[],
  ) {
    this.routePositions = routeNodeIds
      .map((id) => nodes.find((n) => n.id === id))
      .filter((n): n is WorldNodeData => n !== undefined)
      .map((n) => ({ x: n.position.x, y: n.position.y }));
  }

  onNodeReached(cb: (nodeId: string, index: number) => void) {
    this.onNodeReachedCb = cb;
  }

  onComplete(cb: () => void) {
    this.onCompleteCb = cb;
  }

  /** Whether the animation is currently running. */
  get isRunning(): boolean {
    return this.running;
  }

  start() {
    if (this.routePositions.length < 2) {
      this.onCompleteCb?.();
      return;
    }

    this.running = true;
    this.currentSegment = 0;
    this.segmentProgress = 0;

    // Trigger moving visual state on the being
    this.being.setStatus("moving");

    this.tickerCallback = (ticker) => {
      if (!this.running) return;
      this.tick(ticker.deltaTime);
    };

    this.ticker.add(this.tickerCallback);
  }

  stop(restoreStatus: string = "idle") {
    this.running = false;
    if (this.tickerCallback) {
      this.ticker.remove(this.tickerCallback);
      this.tickerCallback = undefined;
    }
    // W4: allow caller to choose the restored status (e.g. "working" when
    // stopping mid-route at a workstation). Default to "idle".
    this.being.setStatus(restoreStatus);
  }

  private tick(deltaTime: number) {
    const from = this.routePositions[this.currentSegment];
    const to = this.routePositions[this.currentSegment + 1];
    if (!from || !to) return;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const segmentLength = Math.sqrt(dx * dx + dy * dy);

    const step = (MOVE_SPEED * deltaTime) / 60 / Math.max(segmentLength, 1);
    this.segmentProgress += step;

    if (this.segmentProgress >= 1) {
      this.segmentProgress = 0;
      this.currentSegment++;

      const reachedNodeId = this.routeNodeIds[this.currentSegment];
      if (reachedNodeId !== undefined) {
        this.onNodeReachedCb?.(reachedNodeId, this.currentSegment);
      }

      if (this.currentSegment >= this.routePositions.length - 1) {
        const lastPos = this.routePositions[this.routePositions.length - 1];
        if (lastPos) {
          this.being.setPosition(lastPos.x, lastPos.y);
          this.statusBubble.update("", lastPos.x, lastPos.y);
        }
        this.stop();
        this.onCompleteCb?.();
        return;
      }
    }

    // 插值当前位置
    const curFrom = this.routePositions[this.currentSegment];
    const curTo = this.routePositions[this.currentSegment + 1];
    if (!curFrom || !curTo) return;
    const x = curFrom.x + (curTo.x - curFrom.x) * this.segmentProgress;
    const y = curFrom.y + (curTo.y - curFrom.y) * this.segmentProgress;

    // Update facing direction based on movement
    const moveDx = curTo.x - curFrom.x;
    if (Math.abs(moveDx) > 1) {
      this.being.setFacing(moveDx > 0 ? "right" : "left");
    }

    this.being.setPosition(x, y);
    const nextNodeId = this.routeNodeIds[this.currentSegment + 1];
    this.statusBubble.update(
      `正在前往${nextNodeId !== undefined ? this.getNodeName(nextNodeId) : ""}`,
      x,
      y,
    );
  }

  private getNodeName(nodeId: string): string {
    return this.nodes.find((n) => n.id === nodeId)?.name ?? nodeId;
  }
}
