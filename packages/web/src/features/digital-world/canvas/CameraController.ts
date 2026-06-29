import { Container } from "pixi.js";

const MIN_SCALE = 0.75;
const MAX_SCALE = 1.6;
const ZOOM_SPEED = 0.08;
const DRAG_THRESHOLD = 4;

export class CameraController {
  private viewport: Container;
  private canvas: HTMLCanvasElement;

  private isDragging = false;
  private hasDragged = false;
  private startPointerX = 0;
  private startPointerY = 0;
  private startViewportX = 0;
  private startViewportY = 0;

  private _scale = 1;

  onDragStart?: () => void;
  onDragEnd?: () => void;
  /** Called when a click occurs (not a drag). */
  onWorldClick?: (worldX: number, worldY: number) => void;
  /** Batch 5 Phase 1: fired whenever the viewport position or scale changes
   *  (drag or zoom) so dependents like the grid can redraw only the newly
   *  visible area instead of relying on a fixed-size canvas. */
  onViewportMove?: () => void;

  constructor(viewport: Container, canvas: HTMLCanvasElement) {
    this.viewport = viewport;
    this.canvas = canvas;
    this.canvas.style.cursor = "grab";
    this.bindEvents();
  }

  get scale(): number {
    return this._scale;
  }

  /** Center the viewport on a world position. */
  centerOn(worldX: number, worldY: number, canvasWidth?: number, canvasHeight?: number) {
    const cw = canvasWidth ?? this.canvas.clientWidth;
    const ch = canvasHeight ?? this.canvas.clientHeight;
    this.viewport.x = cw / 2 - worldX * this._scale;
    this.viewport.y = ch / 2 - worldY * this._scale;
  }

  /** Fit the entire world bounds into the current view.
   *  Ensures the world occupies 55%-70% of the canvas width. */
  fitWorldToView(
    worldBounds: { minX: number; minY: number; maxX: number; maxY: number },
    canvasWidth?: number,
    canvasHeight?: number,
  ) {
    const cw = canvasWidth ?? this.canvas.clientWidth;
    const ch = canvasHeight ?? this.canvas.clientHeight;
    const worldW = worldBounds.maxX - worldBounds.minX;
    const worldH = worldBounds.maxY - worldBounds.minY;

    if (worldW <= 0 || worldH <= 0) return;

    // Target: world should occupy 55%-70% of canvas width
    const minScaleX = (cw * 0.55) / worldW;
    const maxScaleX = (cw * 0.70) / worldW;
    const scaleY = (ch * 0.80) / worldH; // 80% height to leave room for UI

    // Prefer a scale that keeps world within 55-70% width, but also fits vertically
    let scale = Math.min(maxScaleX, scaleY);
    scale = Math.max(scale, minScaleX); // At least 55% width
    scale = Math.min(scale, MAX_SCALE);
    scale = Math.max(scale, MIN_SCALE);
    this._scale = scale;
    this.viewport.scale.set(this._scale);

    const centerX = (worldBounds.minX + worldBounds.maxX) / 2;
    const centerY = (worldBounds.minY + worldBounds.maxY) / 2;
    this.centerOn(centerX, centerY, cw, ch);
  }

  /** Zoom by a delta amount (positive = zoom in). */
  zoom(delta: number, pivotScreenX?: number, pivotScreenY?: number) {
    const oldScale = this._scale;
    this._scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this._scale + delta * ZOOM_SPEED));

    if (pivotScreenX !== undefined && pivotScreenY !== undefined) {
      // Zoom toward the pivot point
      const ratio = this._scale / oldScale;
      this.viewport.x = pivotScreenX - (pivotScreenX - this.viewport.x) * ratio;
      this.viewport.y = pivotScreenY - (pivotScreenY - this.viewport.y) * ratio;
    }

    this.viewport.scale.set(this._scale);
  }

  destroy() {
    this.canvas.style.cursor = "";
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("wheel", this.handleWheel);
  }

  private bindEvents() {
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
  }

  private handlePointerDown = (e: PointerEvent) => {
    this.isDragging = true;
    this.hasDragged = false;
    this.startPointerX = e.clientX;
    this.startPointerY = e.clientY;
    this.startViewportX = this.viewport.x;
    this.startViewportY = this.viewport.y;
    this.canvas.style.cursor = "grabbing";
    this.onDragStart?.();
  };

  private handlePointerMove = (e: PointerEvent) => {
    if (!this.isDragging) return;

    const dx = e.clientX - this.startPointerX;
    const dy = e.clientY - this.startPointerY;

    if (!this.hasDragged && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      this.hasDragged = true;
    }

    if (this.hasDragged) {
      this.viewport.x = this.startViewportX + dx;
      this.viewport.y = this.startViewportY + dy;
      this.onViewportMove?.();
    }
  };

  private handlePointerUp = (_e: PointerEvent) => {
    if (this.isDragging && !this.hasDragged) {
      // It was a click, not a drag — convert screen coords to world coords
      const rect = this.canvas.getBoundingClientRect();
      const screenX = _e.clientX - rect.left;
      const screenY = _e.clientY - rect.top;
      const worldX = (screenX - this.viewport.x) / this._scale;
      const worldY = (screenY - this.viewport.y) / this._scale;
      this.onWorldClick?.(worldX, worldY);
    }
    this.isDragging = false;
    this.canvas.style.cursor = "grab";
    this.onDragEnd?.();
  };

  private handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const pivotX = e.clientX - rect.left;
    const pivotY = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? -1 : 1;
    this.zoom(delta, pivotX, pivotY);
    this.onViewportMove?.();
  };
}
