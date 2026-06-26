import type { Ticker } from "pixi.js";
import type { WorldNodeData } from "../types";
import type { DigitalBeingEntity } from "../canvas/DigitalBeingEntity";
import type { StatusBubbleLayer } from "../canvas/StatusBubbleLayer";

const MOVE_SPEED = 120; // base pixels per second
// §9.5.5: Adaptive speed range — short segments slow down (more deliberate),
// long segments speed up (avoid tedious long walks). Factor in [0.5, 1.5].
const SPEED_MIN_FACTOR = 0.5;
const SPEED_MAX_FACTOR = 1.5;
const SPEED_REF_DISTANCE = 200; // distance at which factor = 1.0

/** §9.5.5: Ease-in-out cubic — smooth acceleration/deceleration. */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class RouteAnimator {
  private tickerCallback?: (ticker: Ticker) => void;
  private currentSegment = 0;
  private segmentProgress = 0;
  private routePositions: { x: number; y: number }[] = [];
  private running = false;
  // §9.5.5: Smooth facing transition — lerp container.scale.x toward
  // target (-1 or 1) instead of instant flip.
  private targetFacingScale = 1;
  private currentFacingScale = 1;

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

    // §9.5.5: Adaptive speed — scale based on segment distance.
    // Short distances move slower (deliberate), long distances faster.
    const speedFactor =
      SPEED_MIN_FACTOR +
      Math.min(segmentLength / SPEED_REF_DISTANCE, 1) *
        (SPEED_MAX_FACTOR - SPEED_MIN_FACTOR);
    const adaptiveSpeed = MOVE_SPEED * speedFactor;

    const step =
      (adaptiveSpeed * deltaTime) / 60 / Math.max(segmentLength, 1);
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

    // §9.5.5: Apply ease-in-out to position interpolation for smooth
    // acceleration/deceleration within each segment.
    const curFrom = this.routePositions[this.currentSegment];
    const curTo = this.routePositions[this.currentSegment + 1];
    if (!curFrom || !curTo) return;
    const easedProgress = easeInOutCubic(this.segmentProgress);
    const x = curFrom.x + (curTo.x - curFrom.x) * easedProgress;
    const y = curFrom.y + (curTo.y - curFrom.y) * easedProgress;

    // §9.5.5: Smooth facing transition — lerp scale.x toward target
    // instead of instant flip. Update target based on movement direction.
    const moveDx = curTo.x - curFrom.x;
    if (Math.abs(moveDx) > 1) {
      this.targetFacingScale = moveDx > 0 ? 1 : -1;
      // Use the being's setFacing for state tracking, but we override
      // the visual scale via smooth lerp below.
      this.being.setFacing(moveDx > 0 ? "right" : "left");
    }
    // Lerp current facing scale toward target (turn rotation transition)
    const lerpFactor = Math.min(deltaTime / 8, 1);
    this.currentFacingScale +=
      (this.targetFacingScale - this.currentFacingScale) * lerpFactor;
    // Apply smoothed scale (preserve Y scale)
    const currentYScale = this.being.container.scale.y || 1;
    this.being.container.scale.set(this.currentFacingScale, currentYScale);

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
