import { Application, Container } from "pixi.js";
import { CANVAS_BG_COLOR } from "../constants";
import { mockNodes, mockEdges, mockBeing } from "../mock/mockWorld";
import type { WorldNodeData, WorldEdgeData, DigitalBeingData } from "../types";
import { WorldGrid } from "./WorldGrid";
import { RoadLayer } from "./RoadLayer";
import { WorkstationNode } from "./WorkstationNode";
import { DigitalBeingEntity } from "./DigitalBeingEntity";
import { StatusBubbleLayer } from "./StatusBubbleLayer";
import { CameraController } from "./CameraController";

export interface WorldAppData {
  nodes: WorldNodeData[];
  edges: WorldEdgeData[];
  being: DigitalBeingData;
}

export type WorldNodeClickHandler = (nodeId: string) => void;
export type WorldBeingClickHandler = (beingId: string) => void;

export class WorldApp {
  private app?: Application;
  private grid = new WorldGrid();
  private roadLayer = new RoadLayer();
  private nodeContainers: import("pixi.js").Container[] = [];
  private _being?: DigitalBeingEntity;
  private _statusBubble?: StatusBubbleLayer;
  private camera?: CameraController;

  /** Viewport container — all world objects live here, can be panned/zoomed. */
  private viewport = new Container();

  private _nodes: WorldNodeData[] = mockNodes;
  private _edges: WorldEdgeData[] = mockEdges;
  private _beingData: DigitalBeingData = { ...mockBeing };
  private _dataVersion = 0;

  /** Callbacks for world object clicks. */
  onNodeClick?: WorldNodeClickHandler;
  onBeingClick?: WorldBeingClickHandler;

  get being(): DigitalBeingEntity | undefined {
    return this._being;
  }

  get statusBubble(): StatusBubbleLayer | undefined {
    return this._statusBubble;
  }

  get nodes(): WorldNodeData[] {
    return this._nodes;
  }

  get edges(): WorldEdgeData[] {
    return this._edges;
  }

  get beingData(): DigitalBeingData {
    return this._beingData;
  }

  get ticker() {
    return this.app?.ticker;
  }

  async mount(container: HTMLElement, data?: WorldAppData) {
    const app = new Application();
    await app.init({
      width: container.clientWidth,
      height: container.clientHeight,
      backgroundColor: CANVAS_BG_COLOR,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      powerPreference: "high-performance",
    });

    container.appendChild(app.canvas);
    this.app = app;

    if (data) {
      this._nodes = data.nodes;
      this._edges = data.edges;
      this._beingData = { ...data.being };
    }

    // Set up viewport
    app.stage.addChild(this.viewport);

    this.drawWorld();
    this.setupCamera();
    this.setupNodeInteraction();
  }

  /**
   * 更新世界数据并重绘画布。
   * 当 nodes/edges/being 的 id 集合发生变化时执行完整重绘，
   * 否则只增量更新 being 位置和状态。
   */
  setData(data: WorldAppData) {
    const nodesChanged = this.idSetsDiffer(this._nodes, data.nodes);
    const edgesChanged = this.idSetsDiffer(this._edges, data.edges);

    this._nodes = data.nodes;
    this._edges = data.edges;
    this._beingData = { ...data.being };

    if (nodesChanged || edgesChanged) {
      // 完整重绘
      this.clearStage();
      this.drawWorld();
      this.setupNodeInteraction();
    } else {
      // 增量更新 being
      this.updateBeingPosition(data.being.currentNodeId);
      this.updateBeingStatus(data.being.statusText);
      this.updateBeingVisualStatus(data.being.status);
    }

    this._dataVersion++;
  }

  resize(width: number, height: number) {
    if (!this.app) return;
    this.app.renderer.resize(width, height);
    this.redrawGrid();
  }

  destroy() {
    this.stopTicker();
    this.camera?.destroy();
    this.grid.destroy();
    this.roadLayer.destroy();
    for (const c of this.nodeContainers) {
      c.destroy({ children: true });
    }
    this._being?.destroy();
    this._statusBubble?.destroy();
    this.viewport.destroy({ children: false });
    this.app?.destroy(true);
    this.app = undefined;
  }

  updateBeingStatus(statusText: string) {
    this._beingData.statusText = statusText;
    if (this._being && this._statusBubble) {
      this._statusBubble.update(
        statusText,
        this._being.container.x,
        this._being.container.y,
      );
    }
  }

  updateBeingPosition(nodeId: string) {
    this._beingData.currentNodeId = nodeId;
    const node = this._nodes.find((n) => n.id === nodeId);
    if (node && this._being) {
      this._being.setPosition(node.position.x, node.position.y);
    }
  }

  /** Update the being's visual status (idle/moving/working/waiting/sleeping/error). */
  updateBeingVisualStatus(status: string) {
    this._being?.setStatus(status);
  }

  /** Center the camera on the being's current position. */
  centerOnBeing() {
    if (!this._being || !this.app) return;
    this.camera?.centerOn(
      this._being.container.x,
      this._being.container.y,
      this.app.renderer.width / (this.app.renderer.resolution || 1),
      this.app.renderer.height / (this.app.renderer.resolution || 1),
    );
  }

  /** Fit the entire world into the current viewport. */
  fitWorldToView() {
    if (!this.app || this._nodes.length === 0) return;
    const bounds = this.computeWorldBounds();
    this.camera?.fitWorldToView(
      bounds,
      this.app.renderer.width / (this.app.renderer.resolution || 1),
      this.app.renderer.height / (this.app.renderer.resolution || 1),
    );
  }

  /** 停止所有 ticker 回调。RouteAnimator 自管理注册/注销，此处只做安全兜底。 */
  stopTicker() {
    // No-op: RouteAnimator manages its own ticker registration.
    // This method is kept for API compatibility and as a safety net.
  }

  private setupCamera() {
    if (!this.app?.canvas) return;
    const canvas = this.app.canvas as HTMLCanvasElement;
    this.camera = new CameraController(this.viewport, canvas);

    // Initial fit
    this.fitWorldToView();
  }

  private setupNodeInteraction() {
    for (const nodeContainer of this.nodeContainers) {
      nodeContainer.eventMode = "static";
      nodeContainer.cursor = "pointer";

      // Hover highlight
      nodeContainer.on("pointerover", () => {
        nodeContainer.alpha = 0.85;
        nodeContainer.scale.set(1.04);
      });
      nodeContainer.on("pointerout", () => {
        nodeContainer.alpha = 1;
        nodeContainer.scale.set(1);
      });

      // Click — only if camera hasn't dragged
      nodeContainer.on("pointerdown", (e: import("pixi.js").FederatedPointerEvent) => {
        e.stopPropagation(); // Prevent camera drag
      });
      nodeContainer.on("pointerup", () => {
        const nodeId = nodeContainer.label;
        if (nodeId) {
          this.onNodeClick?.(nodeId);
        }
      });
    }

    // Being click
    if (this._being) {
      this._being.container.eventMode = "static";
      this._being.container.cursor = "pointer";
      this._being.container.on("pointerdown", (e: import("pixi.js").FederatedPointerEvent) => {
        e.stopPropagation();
      });
      this._being.container.on("pointerup", () => {
        this.onBeingClick?.(this._beingData.id);
      });
    }
  }

  private computeWorldBounds() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of this._nodes) {
      const hw = node.size.width / 2;
      const hh = node.size.height / 2;
      if (node.position.x - hw < minX) minX = node.position.x - hw;
      if (node.position.y - hh < minY) minY = node.position.y - hh;
      if (node.position.x + hw > maxX) maxX = node.position.x + hw;
      if (node.position.y + hh > maxY) maxY = node.position.y + hh;
    }
    return { minX, minY, maxX, maxY };
  }

  private clearStage() {
    this.viewport.removeChildren();
    this.grid.destroy();
    this.roadLayer.destroy();
    for (const c of this.nodeContainers) {
      c.destroy({ children: true });
    }
    this.nodeContainers = [];
    this._being?.destroy();
    this._being = undefined;
    this._statusBubble?.destroy();
    this._statusBubble = undefined;
    // 重新创建 grid 和 roadLayer
    this.grid = new WorldGrid();
    this.roadLayer = new RoadLayer();
  }

  private drawWorld() {
    if (!this.app) return;

    // 1. 网格 — large enough to cover expanded world
    const gridW = Math.max(this.app.renderer.width, 3000);
    const gridH = Math.max(this.app.renderer.height, 2000);
    const gridGfx = this.grid.draw(gridW, gridH);
    this.viewport.addChild(gridGfx);

    // 2. 道路
    const roadGfx = this.roadLayer.draw(this._nodes, this._edges);
    this.viewport.addChild(roadGfx);

    // 3. 工作台节点
    for (const node of this._nodes) {
      const c = WorkstationNode.draw(node);
      this.nodeContainers.push(c);
      this.viewport.addChild(c);
    }

    // 4. 数字生命
    const homeNode = this._nodes.find((n) => n.id === this._beingData.currentNodeId);
    if (homeNode) {
      this._being = new DigitalBeingEntity();
      this._being.setPosition(homeNode.position.x, homeNode.position.y);
      this._being.setStatus(this._beingData.status);
      this.viewport.addChild(this._being.container);

      // 5. 状态气泡
      this._statusBubble = new StatusBubbleLayer();
      this._statusBubble.update(
        this._beingData.statusText,
        homeNode.position.x,
        homeNode.position.y,
      );
      this.viewport.addChild(this._statusBubble.container);
    }
  }

  private redrawGrid() {
    if (!this.app) return;
    // Remove old grid from viewport
    const oldGrid = this.viewport.getChildAt(0);
    const gridW = Math.max(this.app.renderer.width, 3000);
    const gridH = Math.max(this.app.renderer.height, 2000);
    const newGrid = this.grid.draw(gridW, gridH);
    if (oldGrid) {
      this.viewport.removeChild(oldGrid);
    }
    this.viewport.addChildAt(newGrid, 0);
  }

  private idSetsDiffer<T extends { id: string }>(old: T[], next: T[]): boolean {
    if (old.length !== next.length) return true;
    const oldIds = new Set(old.map((i) => i.id));
    return next.some((i) => !oldIds.has(i.id));
  }
}
