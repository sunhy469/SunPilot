import { Application, Container, Graphics } from "pixi.js";
import {
  getCurrentWorldTheme,
  setCurrentWorldTheme,
  GRID_PARALLAX_FACTOR,
  type WorldTheme,
} from "../constants";
import { mockNodes, mockEdges, mockBeing } from "../mock/mockWorld";
import type { WorldNodeData, WorldEdgeData, DigitalBeingData } from "../types";
import type { RouteAnimator } from "../path/route-animation";
import { WorldGrid, type CameraBounds } from "./WorldGrid";
import { RoadLayer } from "./RoadLayer";
import { WorkstationNode, buildIconTextureCache, type IconTextureCache } from "./WorkstationNode";
import { DigitalBeingEntity } from "./DigitalBeingEntity";
import { StatusBubbleLayer } from "./StatusBubbleLayer";
import { CameraController } from "./CameraController";
import { ParticleLayer } from "./ParticleLayer";
import { SoundManager } from "./SoundManager";

export interface WorldAppData {
  nodes: WorldNodeData[];
  edges: WorldEdgeData[];
  being: DigitalBeingData;
  /** Task 10 (§9.5.2): all beings. Falls back to [being] when omitted. */
  beings?: DigitalBeingData[];
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
  // Task 11: particle effects (working sparks, road flow lights, Zzz).
  private _particleLayer?: ParticleLayer;

  /** Viewport container — all world objects live here, can be panned/zoomed. */
  private viewport = new Container();

  // C20: explicit reference to the grid Graphics so redrawGrid doesn't rely on
  // viewport child ordering (getChildAt(0) was fragile).
  private gridGraphics?: Graphics;

  // Batch 5 Phase 1: set to true after the first explicit app.render() in
  // mount(). Until then, ParticleLayer startup is deferred so the first frame
  // paints without waiting for particle/road-light Graphics creation.
  private _firstFrameDone = false;

  // §9.3.1: mouse-follow — a canvas pointermove listener that converts the
  // screen position to world coordinates and feeds it to every being so their
  // eyes track the cursor. Removed in destroy().
  private _pointerMoveHandler?: (e: PointerEvent) => void;

  // C19/W7: the currently active RouteAnimator, if any. Used to detect
  // in-progress movement so polling updates don't interrupt the animation, and
  // so destroy() can stop it cleanly before tearing down the app.
  private _activeAnimator: RouteAnimator | null = null;

  // W12: set once destroy() is called so the async mount() can bail out.
  private _disposed = false;

  private _nodes: WorldNodeData[] = mockNodes;
  private _edges: WorldEdgeData[] = mockEdges;
  private _beingData: DigitalBeingData = { ...mockBeing };
  private _dataVersion = 0;

  // Task 10 (§9.5.2): multi-being support. `_beings` holds every rendered
  // being; `_being` (above) is the primary one kept for backwards-compatible
  // APIs used by useBeingMovement/centerOnBeing.
  private _beings = new Map<string, DigitalBeingEntity>();
  private _beingBubbles = new Map<string, StatusBubbleLayer>();
  private _beingDataList: DigitalBeingData[] = [{ ...mockBeing }];
  private _selectedBeingId: string | null = null;

  // §9.2.1: pre-rendered workstation icon textures. Built once on mount and
  // reused across redraws so drawWorld() uses Sprites instead of rebuilding
  // Graphics for icons. Textures survive clearStage() (Sprites don't own
  // them) and are destroyed in destroy().
  private _iconTextures: IconTextureCache = new Map();
  // Dirty flag: set when a structural change (nodes/edges id set) requires a
  // full redraw. setData() only redraws when this is true; otherwise it just
  // updates the being position/status. See idSetsDiffer().
  private _nodesDirty = true;

  // Task 15 (§9.5.3): world editor (dev tool) state. When enabled, nodes are
  // draggable, double-click on empty canvas adds a node, right-click on a
  // node deletes it (plus connected edges), and the world can be exported /
  // imported as JSON.
  private _editorMode = false;
  private _editorDblClickHandler: ((e: MouseEvent) => void) | null = null;
  private _editorNodeIdSeq = 0;

  // Task 16 (§9.5.6): sound effects. A single SoundManager plays short
  // oscillator beeps on being status transitions (arrive / startWork /
  // complete / error). `_prevStatus` tracks each being's last status so we
  // only beep on real transitions.
  private _sound = new SoundManager();
  private _prevStatus = new Map<string, string>();

  // §9.2.5: event delegation state. Instead of attaching per-node listeners,
  // a single set of pointer handlers lives on the viewport and identifies the
  // target node via `event.target.label` (walked up the parent chain).
  // `_nodeIds` is rebuilt on every redraw for fast lookup; `_draggedNode`
  // tracks the node being dragged in editor mode so globalpointermove can
  // update its position; `_viewportInteractionAttached` guards against
  // duplicate handler registration across repeated setupNodeInteraction calls.
  private _nodeIds = new Set<string>();
  private _draggedNode: import("pixi.js").Container | null = null;
  private _dragOffsetX = 0;
  private _dragOffsetY = 0;
  private _viewportInteractionAttached = false;

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

  /** Task 10: all rendered beings by id. */
  get beings(): Map<string, DigitalBeingEntity> {
    return this._beings;
  }

  /** Task 10: id of the currently selected being (null = primary). */
  get selectedBeingId(): string | null {
    return this._selectedBeingId;
  }

  get ticker() {
    return this.app?.ticker;
  }

  async mount(container: HTMLElement, data?: WorldAppData) {
    const app = new Application();
    // Task 13 (§9.5.4): background color follows the active WorldTheme.
    await app.init({
      width: container.clientWidth,
      height: container.clientHeight,
      backgroundColor: getCurrentWorldTheme().canvasBg,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      powerPreference: "high-performance",
    });

    // W12: guard against destroy() racing with the async init — if the app was
    // torn down while awaiting init(), destroy the just-created app and bail.
    if (this._disposed) {
      app.destroy(true);
      return;
    }

    container.appendChild(app.canvas);
    this.app = app;

    // §9.2.1: pre-render the 6 workstation icon types into Textures once.
    // Requires a live renderer, so it must happen after app.init().
    this._iconTextures = buildIconTextureCache(app.renderer);

    if (data) {
      this._nodes = data.nodes;
      this._edges = data.edges;
      this._beingData = { ...data.being };
      this._beingDataList = data.beings ? data.beings.map((b) => ({ ...b })) : [{ ...data.being }];
    }

    // Set up viewport
    app.stage.addChild(this.viewport);

    this.drawWorld();
    this.setupCamera();
    this.setupNodeInteraction();
    this.setupMouseTracking();

    // Batch 5 Phase 1 (§9.5 — load performance): render the first frame
    // explicitly instead of waiting for the ticker. WebGL shader compilation
    // happens during init(), so the canvas would otherwise stay blank until
    // the first tick fires.
    app.render();
    this._firstFrameDone = true;

    // Batch 5 Phase 1: defer ParticleLayer startup to after the first frame
    // so particle/road-light Graphics creation doesn't block initial paint.
    if (this._particleLayer) {
      const pw = app.renderer.width / (app.renderer.resolution || 1);
      const ph = app.renderer.height / (app.renderer.resolution || 1);
      requestAnimationFrame(() => {
        if (this._disposed) return;
        this._particleLayer?.setBounds(pw, ph);
        this._particleLayer?.setRoads(this._nodes, this._edges);
        this._particleLayer?.start();
      });
    }
  }

  /**
   * 更新世界数据并重绘画布。
   * 当 nodes/edges/being 的 id 集合发生变化时执行完整重绘，
   * 否则只增量更新 being 位置和状态。
   */
  setData(data: WorldAppData) {
    const nodesChanged = this.idSetsDiffer(this._nodes, data.nodes);
    const edgesChanged = this.idSetsDiffer(this._edges, data.edges);
    // §9.2.1: explicit dirty flag — only a structural change (node/edge id
    // set differs) triggers a full redraw; otherwise we just update the
    // being position/status, avoiding per-frame Graphics rebuilds.
    this._nodesDirty = nodesChanged || edgesChanged;

    this._nodes = data.nodes;
    this._edges = data.edges;

    // Task 10: build the full being list and track id-set changes.
    const beingsList = data.beings ?? [data.being];
    const beingsChanged = this.idSetsDiffer(this._beingDataList, beingsList);
    this._beingDataList = beingsList.map((b) => ({ ...b }));
    this._beingData = { ...beingsList[0]! };

    if (this._nodesDirty || beingsChanged) {
      // Full redraw — nodes/edges/being set changed.
      this.clearStage();
      this.drawWorld();
      this.setupNodeInteraction();
    } else {
      // C19: when a route animation is in progress, skip the position update so
      // polling data doesn't snap the being back to a node mid-route. Only
      // refresh the status text and visual status.
      if (!this.isAnimating()) {
        // Update every being's position from its current node.
        for (const bd of beingsList) {
          this.updateBeingPositionFor(bd.id, bd.currentNodeId);
        }
      }
      // Update every being's status text + visual status.
      for (const bd of beingsList) {
        this.updateBeingStatusFor(bd.id, bd.statusText);
        this.updateBeingVisualStatusFor(bd.id, bd.status);
      }
    }

    this._dataVersion++;
  }

  /** C19/W7: register the active route animator. Pass null to clear. */
  registerAnimator(animator: RouteAnimator | null) {
    this._activeAnimator = animator;
  }

  /** C19: whether a route animation is currently in progress. */
  isAnimating(): boolean {
    return this._activeAnimator?.isRunning ?? false;
  }

  resize(width: number, height: number) {
    if (!this.app) return;
    this.app.renderer.resize(width, height);
    this.redrawGrid();
    // Batch 5 Phase 2: update ambient particle distribution on resize.
    this._particleLayer?.setBounds(width, height);
  }

  destroy() {
    this._disposed = true;
    // W7: stop any in-progress route animation before tearing down the app so
    // its ticker callback doesn't fire during/after destruction.
    this._activeAnimator?.stop();
    this._activeAnimator = null;
    // Task 15: remove the editor double-click listener before the canvas goes away.
    if (this._editorDblClickHandler) {
      const canvas = this.app?.canvas as HTMLCanvasElement | undefined;
      canvas?.removeEventListener("dblclick", this._editorDblClickHandler);
      this._editorDblClickHandler = null;
    }
    this.stopTicker();
    this.camera?.destroy();
    // Task 16: release the AudioContext used by sound effects.
    this._sound.destroy();
    this.grid.destroy();
    this.roadLayer.destroy();
    for (const c of this.nodeContainers) {
      c.destroy({ children: true });
    }
    // Task 10: destroy all beings + bubbles.
    // §FIX: _being is the first entry in _beings (see initWorldObjects L873).
    // Destroying _being separately and then iterating _beings causes a
    // double-destroy on the primary entity — the second call hits
    // stopAnimation() which sets .x on already-destroyed Graphics layers.
    for (const entity of this._beings.values()) {
      entity.destroy();
    }
    this._beings.clear();
    this._being = undefined;
    this._statusBubble = undefined;
    for (const bubble of this._beingBubbles.values()) {
      bubble.destroy();
    }
    this._beingBubbles.clear();
    // Task 11: destroy particle layer.
    this._particleLayer?.destroy();
    this._particleLayer = undefined;
    // §9.2.1: release the pre-rendered icon textures.
    for (const texture of this._iconTextures.values()) {
      texture.destroy(true);
    }
    this._iconTextures.clear();
    // §9.2.5: detach the delegated viewport pointer handlers before the
    // viewport is torn down so no callback fires during/after destruction.
    this.detachViewportInteractions();
    // §9.3.1: detach the mouse-follow listener before the canvas is torn down.
    if (this._pointerMoveHandler && this.app?.canvas) {
      (this.app.canvas as HTMLCanvasElement).removeEventListener("pointermove", this._pointerMoveHandler);
      this._pointerMoveHandler = undefined;
    }
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

  // ── Task 10: per-being helpers ──────────────────────

  /** Get a being entity by id (undefined if not rendered). */
  getBeing(id: string): DigitalBeingEntity | undefined {
    return this._beings.get(id);
  }

  /** Select a being by id (used for click-to-focus + panel targeting). */
  selectBeing(id: string | null) {
    this._selectedBeingId = id;
  }

  /** Update status text for a specific being. */
  private updateBeingStatusFor(id: string, statusText: string) {
    const entity = this._beings.get(id);
    const bubble = this._beingBubbles.get(id);
    const bd = this._beingDataList.find((b) => b.id === id);
    if (bd) bd.statusText = statusText;
    if (entity && bubble) {
      bubble.update(statusText, entity.container.x, entity.container.y);
    }
    if (id === this._beingData.id) {
      this.updateBeingStatus(statusText);
    }
  }

  /** Update node position for a specific being. */
  private updateBeingPositionFor(id: string, nodeId: string) {
    const entity = this._beings.get(id);
    const bd = this._beingDataList.find((b) => b.id === id);
    if (bd) bd.currentNodeId = nodeId;
    const node = this._nodes.find((n) => n.id === nodeId);
    if (node && entity) {
      entity.setPosition(node.position.x, node.position.y);
    }
    if (id === this._beingData.id) {
      this.updateBeingPosition(nodeId);
    }
  }

  /** Update visual status for a specific being. */
  private updateBeingVisualStatusFor(id: string, status: string) {
    // Task 16 (§9.5.6): play a sound on meaningful status transitions.
    const prev = this._prevStatus.get(id);
    if (prev !== status) {
      this._prevStatus.set(id, status);
      this.playStatusSound(prev, status);
    }
    this._beings.get(id)?.setStatus(status);
    if (id === this._beingData.id) {
      this.updateBeingVisualStatus(status);
    }
  }

  /**
   * Task 16: map a status transition to a sound event.
   *   moving → idle        → arrive (reached destination)
   *   * → working          → startWork
   *   working → idle/publishing → complete
   *   * → error            → error
   */
  private playStatusSound(prev: string | undefined, next: string) {
    if (prev === next) return;
    if (next === "error") {
      this._sound.play("error");
    } else if (next === "working") {
      this._sound.play("startWork");
    } else if (prev === "working" && (next === "idle" || next === "publishing")) {
      this._sound.play("complete");
    } else if (prev === "moving" && next === "idle") {
      this._sound.play("arrive");
    }
  }

  /** Task 16: mute or unmute all sound effects (used by settings). */
  setSoundMuted(muted: boolean) {
    this._sound.setMuted(muted);
  }

  /** Task 16: whether sound effects are currently muted. */
  get soundMuted(): boolean {
    return this._sound.muted;
  }

  /** Center the camera on the being's current position. Pass an id to target
   *  a specific being (Task 10); otherwise uses the selected/primary being. */
  centerOnBeing(beingId?: string) {
    const id = beingId ?? this._selectedBeingId ?? this._beingData.id;
    const entity = this._beings.get(id) ?? this._being;
    if (!entity || !this.app) return;
    this.camera?.centerOn(
      entity.container.x,
      entity.container.y,
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

  /**
   * Task 14 (§9.5.7): zoom the camera by a delta (positive = zoom in,
   * negative = zoom out). Delegates to CameraController.zoom, centered on
   * the canvas midpoint so keyboard +/- zooms toward the screen center.
   */
  zoom(delta: number) {
    if (!this.app || !this.camera) return;
    const w = this.app.renderer.width / (this.app.renderer.resolution || 1);
    const h = this.app.renderer.height / (this.app.renderer.resolution || 1);
    this.camera.zoom(delta, w / 2, h / 2);
  }

  /**
   * Task 14 (§9.5.7): pause or resume all canvas animations by stopping /
   * starting the app ticker. Pausing freezes being idle/move loops, route
   * animations, and particle effects without tearing anything down.
   */
  setAnimationPaused(paused: boolean) {
    if (!this.app) return;
    if (paused) {
      this.app.ticker.stop();
    } else {
      this.app.ticker.start();
    }
  }

  /** 停止 ticker，作为 RouteAnimator 注销之外的安全兜底。 */
  stopTicker() {
    // W7: actually stop the ticker so callbacks (e.g. a leaked RouteAnimator
    // callback) can't fire after destroy. RouteAnimator manages its own
    // registration; this is the safety net.
    this.app?.ticker?.stop();
  }

  private setupCamera() {
    if (!this.app?.canvas) return;
    const canvas = this.app.canvas as HTMLCanvasElement;
    this.camera = new CameraController(this.viewport, canvas);

    // Batch 5 Phase 1 (§9.5 — infinite canvas): redraw the grid whenever the
    // viewport moves (drag or zoom) so the visible dot range follows the
    // camera. Without this, panning past the initial grid area shows blank.
    this.camera.onViewportMove = () => this.redrawGrid();

    // Initial fit
    this.fitWorldToView();
  }

  private setupNodeInteraction() {
    // §9.2.5: event delegation — instead of attaching per-node listeners, a
    // single set of pointer handlers lives on the viewport and dispatches
    // based on `event.target`. PixiJS events bubble up from each node
    // container (eventMode = "static") to the viewport.
    //
    // Rebuild the node-id lookup set so the delegated handlers can identify
    // whether the hit target (or one of its ancestors) is a node container.
    this._nodeIds = new Set(this._nodes.map((n) => n.id));

    // Configure each node container: static eventMode + cursor. The `label`
    // (node id) is already set by WorkstationNode.draw — delegation relies on
    // it to identify the clicked node.
    for (const nodeContainer of this.nodeContainers) {
      nodeContainer.eventMode = "static";
      nodeContainer.cursor = this._editorMode ? "move" : "pointer";
    }

    // Task 10: wire every being container so its events bubble to the
    // viewport. Being containers use a `being:<id>` label so the delegated
    // handlers can distinguish them from node containers.
    for (const [id, entity] of this._beings) {
      entity.container.eventMode = "static";
      entity.container.cursor = "pointer";
      entity.container.label = `being:${id}`;
    }

    // Detach any previously attached viewport handlers (setupNodeInteraction
    // runs again after every redraw / editor-mode toggle) before re-binding.
    this.detachViewportInteractions();

    const viewport = this.viewport;
    viewport.eventMode = "static";

    // ── Hover highlight (delegated) ──
    viewport.on("pointerover", (e: import("pixi.js").FederatedPointerEvent) => {
      const nodeContainer = this.findNodeContainerFromTarget(e.target);
      if (nodeContainer) {
        nodeContainer.alpha = 0.85;
        nodeContainer.scale.set(1.04);
      }
    });
    viewport.on("pointerout", (e: import("pixi.js").FederatedPointerEvent) => {
      const nodeContainer = this.findNodeContainerFromTarget(e.target);
      if (nodeContainer) {
        nodeContainer.alpha = 1;
        nodeContainer.scale.set(1);
      }
    });

    // ── pointerdown: start editor drag or just stop propagation ──
    viewport.on("pointerdown", (e: import("pixi.js").FederatedPointerEvent) => {
      const nodeContainer = this.findNodeContainerFromTarget(e.target);
      if (nodeContainer) {
        e.stopPropagation(); // Prevent camera drag
        if (this._editorMode) {
          const local = e.getLocalPosition(this.viewport);
          const nodeId = nodeContainer.label;
          const node = this._nodes.find((n) => n.id === nodeId);
          if (node) {
            this._draggedNode = nodeContainer;
            this._dragOffsetX = local.x - node.position.x;
            this._dragOffsetY = local.y - node.position.y;
          }
        }
        return;
      }
      const beingId = this.findBeingIdFromTarget(e.target);
      if (beingId) {
        e.stopPropagation(); // Prevent camera drag on being click
      }
    });

    // ── globalpointermove: update dragged node position (editor mode) ──
    viewport.on("globalpointermove", (e: import("pixi.js").FederatedPointerEvent) => {
      if (!this._editorMode || !this._draggedNode) return;
      const local = e.getLocalPosition(this.viewport);
      const nodeId = this._draggedNode.label;
      const node = this._nodes.find((n) => n.id === nodeId);
      if (!node) return;
      node.position.x = local.x - this._dragOffsetX;
      node.position.y = local.y - this._dragOffsetY;
      this._draggedNode.x = node.position.x;
      this._draggedNode.y = node.position.y;
    });

    // ── pointerup: end editor drag or fire click ──
    const endEditorDrag = () => {
      this._draggedNode = null;
    };
    viewport.on("pointerup", (e: import("pixi.js").FederatedPointerEvent) => {
      // Editor drag end — swallow the click when a drag just ended.
      if (this._editorMode && this._draggedNode) {
        endEditorDrag();
        return;
      }
      // Click — fire onNodeClick / onBeingClick based on the hit target.
      const nodeContainer = this.findNodeContainerFromTarget(e.target);
      if (nodeContainer) {
        const nodeId = nodeContainer.label;
        if (nodeId) {
          this.onNodeClick?.(nodeId);
        }
        return;
      }
      const beingId = this.findBeingIdFromTarget(e.target);
      if (beingId) {
        this.selectBeing(beingId);
        this.onBeingClick?.(beingId);
      }
    });
    // pointerupoutside: ensure editor drag ends even if released off-canvas.
    viewport.on("pointerupoutside", endEditorDrag);

    // ── rightclick: delete node (editor mode only) ──
    viewport.on("rightclick", (e: import("pixi.js").FederatedPointerEvent) => {
      if (!this._editorMode) return;
      const nodeContainer = this.findNodeContainerFromTarget(e.target);
      if (!nodeContainer) return;
      e.stopPropagation();
      const nodeId = nodeContainer.label;
      if (!nodeId) return;
      this.deleteNode(nodeId);
    });

    this._viewportInteractionAttached = true;

    // Task 15: wire or unwire the canvas double-click (add node) listener.
    this.syncEditorDblClick();
  }

  /**
   * §9.2.5: walk up the parent chain from `target` to find a Container whose
   * `label` matches a known node id. Returns null if the target is not on or
   * inside a node container. Handles the case where `event.target` is a child
   * Graphics/Sprite of the node container rather than the container itself.
   */
  private findNodeContainerFromTarget(target: unknown): import("pixi.js").Container | null {
    let current = target as import("pixi.js").Container | null;
    while (current) {
      const label = current.label;
      if (label && this._nodeIds.has(label)) {
        return current;
      }
      current = current.parent ?? null;
    }
    return null;
  }

  /**
   * §9.2.5: walk up the parent chain from `target` to find a being container
   * (label = `being:<id>`). Returns the being id, or null if not on a being.
   */
  private findBeingIdFromTarget(target: unknown): string | null {
    let current = target as import("pixi.js").Container | null;
    const prefix = "being:";
    while (current) {
      const label = current.label;
      if (label && label.startsWith(prefix)) {
        return label.slice(prefix.length);
      }
      current = current.parent ?? null;
    }
    return null;
  }

  /**
   * §9.2.5: remove the delegated viewport pointer handlers. Called before
   * re-binding (setupNodeInteraction runs after every redraw) and in destroy.
   */
  private detachViewportInteractions() {
    if (!this._viewportInteractionAttached) return;
    this.viewport.removeAllListeners();
    this._viewportInteractionAttached = false;
    this._draggedNode = null;
  }

  /**
   * Task 15 (§9.5.3): toggle the world editor (dev tool). When enabled, nodes
   * become draggable, double-click on empty canvas adds a node, and
   * right-click on a node deletes it. Re-runs setupNodeInteraction so the
   * node pointer handlers swap to editor behavior.
   */
  setEditorMode(enabled: boolean) {
    this._editorMode = enabled;
    // Re-bind node interaction with the new mode.
    this.setupNodeInteraction();
  }

  get editorMode(): boolean {
    return this._editorMode;
  }

  /**
   * Task 15: attach/detach the native DOM dblclick listener that adds a new
   * node at the clicked world position. Only active in editor mode.
   */
  private syncEditorDblClick() {
    const canvas = this.app?.canvas as HTMLCanvasElement | undefined;
    if (!canvas) return;

    // Always remove the previous listener first to avoid duplicates.
    if (this._editorDblClickHandler) {
      canvas.removeEventListener("dblclick", this._editorDblClickHandler);
      this._editorDblClickHandler = null;
    }

    if (!this._editorMode) return;

    this._editorDblClickHandler = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      // Convert screen → world coords via the viewport transform.
      const scale = this.camera?.scale ?? 1;
      const worldX = (screenX - this.viewport.x) / scale;
      const worldY = (screenY - this.viewport.y) / scale;
      this.addNodeAt(worldX, worldY);
    };
    canvas.addEventListener("dblclick", this._editorDblClickHandler);
  }

  /**
   * Task 15: add a new workstation node at the given world position. Uses a
   * generated id and default size/type, then triggers a full redraw.
   */
  private addNodeAt(worldX: number, worldY: number) {
    this._editorNodeIdSeq++;
    const id = `node_editor_${Date.now()}_${this._editorNodeIdSeq}`;
    const newNode: WorldNodeData = {
      id,
      type: "status_station",
      name: `节点 ${this._editorNodeIdSeq}`,
      position: { x: worldX, y: worldY },
      size: { width: 96, height: 72 },
    };
    this._nodes = [...this._nodes, newNode];
    this._nodesDirty = true;
    this.clearStage();
    this.drawWorld();
    this.setupNodeInteraction();
  }

  /**
   * Task 15: delete a node by id along with any edges connected to it, then
   * trigger a full redraw.
   */
  private deleteNode(nodeId: string) {
    this._nodes = this._nodes.filter((n) => n.id !== nodeId);
    this._edges = this._edges.filter(
      (e) => e.fromNodeId !== nodeId && e.toNodeId !== nodeId,
    );
    this._nodesDirty = true;
    this.clearStage();
    this.drawWorld();
    this.setupNodeInteraction();
  }

  /**
   * Task 15: export the current world layout (nodes + edges) as a plain
   * JSON-serializable object. Useful for saving dev-authored layouts.
   */
  exportWorld(): { nodes: WorldNodeData[]; edges: WorldEdgeData[] } {
    return {
      nodes: this._nodes.map((n) => ({ ...n, position: { ...n.position }, size: { ...n.size } })),
      edges: this._edges.map((e) => ({ ...e })),
    };
  }

  /**
   * Task 15: import a world layout (nodes + edges) from a JSON object,
   * replacing the current layout and triggering a full redraw.
   */
  importWorld(data: { nodes: WorldNodeData[]; edges: WorldEdgeData[] }) {
    this._nodes = data.nodes.map((n) => ({ ...n, position: { ...n.position }, size: { ...n.size } }));
    this._edges = data.edges.map((e) => ({ ...e }));
    this._nodesDirty = true;
    if (this.app) {
      this.clearStage();
      this.drawWorld();
      this.setupNodeInteraction();
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
    this.gridGraphics = undefined;
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
    // Task 10: destroy all beings + bubbles.
    for (const entity of this._beings.values()) {
      entity.destroy();
    }
    this._beings.clear();
    for (const bubble of this._beingBubbles.values()) {
      bubble.destroy();
    }
    this._beingBubbles.clear();
    // Task 16: clear the per-being status tracker so stale ids don't linger.
    this._prevStatus.clear();
    // Task 11: destroy particle layer.
    this._particleLayer?.destroy();
    this._particleLayer = undefined;
    // 重新创建 grid 和 roadLayer
    this.grid = new WorldGrid();
    this.roadLayer = new RoadLayer();
  }

  private drawWorld() {
    if (!this.app) return;

    // 1. 网格 — Batch 5 Phase 1: draw only the visible area (plus buffer) so
    // the canvas behaves as an infinite grid that follows the viewport.
    // C20: keep an explicit reference instead of relying on child order.
    this.gridGraphics = this.grid.draw(this.getCameraBounds());
    this.viewport.addChild(this.gridGraphics);
    this.applyGridParallax();

    // 2. 道路
    const roadGfx = this.roadLayer.draw(this._nodes, this._edges);
    this.viewport.addChild(roadGfx);

    // 3. 工作台节点 — use cached icon textures so icons render as Sprites.
    for (const node of this._nodes) {
      const c = WorkstationNode.draw(node, this._iconTextures);
      this.nodeContainers.push(c);
      this.viewport.addChild(c);
    }

    // 4. 数字生命 — Task 10: render ALL beings independently. Each entity is
    // given the app-specific ticker (§9.2.2) so its animations are cleaned up
    // automatically on destroy.
    const beingsToRender = this._beingDataList;
    let primaryAssigned = false;
    for (const bd of beingsToRender) {
      const homeNode = this._nodes.find((n) => n.id === bd.currentNodeId);
      if (!homeNode) continue;
      const entity = new DigitalBeingEntity(this.app.ticker);
      entity.setPosition(homeNode.position.x, homeNode.position.y);
      entity.setStatus(bd.status);
      this.viewport.addChild(entity.container);
      this._beings.set(bd.id, entity);
      // Task 16: seed the previous-status tracker so the initial render
      // doesn't fire a spurious sound on the first polling update.
      this._prevStatus.set(bd.id, bd.status);

      // 状态气泡
      const bubble = new StatusBubbleLayer();
      bubble.update(bd.statusText, homeNode.position.x, homeNode.position.y);
      this.viewport.addChild(bubble.container);
      this._beingBubbles.set(bd.id, bubble);

      // First rendered being is the primary (backwards-compat).
      if (!primaryAssigned) {
        this._being = entity;
        this._statusBubble = bubble;
        primaryAssigned = true;
      }
    }

    // 5. Task 11: particle effects — working sparks, road flow lights, Zzz.
    //    The getter reads live being positions each frame so particles track
    //    beings during route animations.
    //    Batch 5 Phase 1: ParticleLayer.setRoads() + start() are deferred to
    //    after the first frame on initial mount so particle/road-light
    //    Graphics creation doesn't block the initial paint. On subsequent
    //    redraws (setData/setTheme) the first frame is already done, so start
    //    immediately.
    this._particleLayer = new ParticleLayer(this.app.ticker, () =>
      this._beingDataList.map((bd) => {
        const e = this._beings.get(bd.id);
        return { id: bd.id, x: e?.container.x ?? 0, y: e?.container.y ?? 0, status: bd.status };
      }),
    );
    this.viewport.addChild(this._particleLayer.container);
    if (this._firstFrameDone) {
      const w = this.app.renderer.width / (this.app.renderer.resolution || 1);
      const h = this.app.renderer.height / (this.app.renderer.resolution || 1);
      this._particleLayer.setBounds(w, h);
      this._particleLayer.setRoads(this._nodes, this._edges);
      this._particleLayer.start();
    }
  }

  private redrawGrid() {
    if (!this.app) return;
    // C20: operate on the explicit grid reference instead of getChildAt(0),
    // which was fragile and assumed the grid was always the first child.
    const oldGrid = this.gridGraphics;
    this.gridGraphics = this.grid.draw(this.getCameraBounds());
    if (oldGrid) {
      this.viewport.removeChild(oldGrid);
      oldGrid.destroy();
    }
    // Batch 5 Phase 1: the background gradient layer has been removed — the
    // solid `app.renderer.background.color` (set in mount/setTheme) serves as
    // the base color. The grid is always the bottom-most viewport child.
    this.viewport.addChildAt(this.gridGraphics, 0);
    // Batch 5 Phase 2: apply parallax offset so the grid moves at 0.92x the
    // camera speed, adding subtle depth.
    this.applyGridParallax();
  }

  /**
   * Batch 5 Phase 2 (§9.5 §3.2 — parallax): offset the grid Graphics position
   * by -8% of the camera position (converted to world space) so the grid
   * visually lags slightly behind the world objects during panning.
   */
  private applyGridParallax() {
    if (!this.gridGraphics) return;
    const scale = this.viewport.scale.x || 1;
    this.gridGraphics.x = (-GRID_PARALLAX_FACTOR * this.viewport.x) / scale;
    this.gridGraphics.y = (-GRID_PARALLAX_FACTOR * this.viewport.y) / scale;
  }

  /**
   * Batch 5 Phase 1 (§9.5 — infinite canvas): compute the visible world-space
   * rectangle from the current camera transform (viewport position + scale +
   * renderer size). Used by the grid so it only draws dots inside the
   * viewport plus a small buffer, enabling effectively infinite panning.
   */
  private getCameraBounds(): CameraBounds {
    if (!this.app) {
      return { minX: 0, minY: 0, maxX: 3000, maxY: 2000 };
    }
    const screenW = this.app.renderer.width / (this.app.renderer.resolution || 1);
    const screenH = this.app.renderer.height / (this.app.renderer.resolution || 1);
    // viewport.toLocal maps screen-space (CSS) coordinates to world coords
    // accounting for both position and scale.
    const topLeft = this.viewport.toLocal({ x: 0, y: 0 });
    const bottomRight = this.viewport.toLocal({ x: screenW, y: screenH });
    return {
      minX: Math.min(topLeft.x, bottomRight.x),
      minY: Math.min(topLeft.y, bottomRight.y),
      maxX: Math.max(topLeft.x, bottomRight.x),
      maxY: Math.max(topLeft.y, bottomRight.y),
    };
  }

  /**
   * Task 13 (§9.5.4): switch the active world theme and recolor the canvas.
   * Updates the module-level theme, the app background color, and triggers a
   * full redraw so grid/roads/nodes/labels pick up the new colors.
   */
  setTheme(theme: WorldTheme) {
    setCurrentWorldTheme(theme);
    if (this.app) {
      this.app.renderer.background.color = theme.canvasBg;
    }
    // Force a full redraw on the next setData, or redraw immediately if the
    // app is already mounted.
    this._nodesDirty = true;
    if (this.app) {
      this.clearStage();
      this.drawWorld();
      this.setupNodeInteraction();
    }
  }

  /** Task 13: the currently active world theme. */
  getTheme(): WorldTheme {
    return getCurrentWorldTheme();
  }

  /**
   * §9.3.1: wire a canvas pointermove listener that converts the cursor's
   * screen position to world coordinates (via viewport.toLocal) and feeds it
   * to every being so their pupils track the mouse. Uses a native DOM listener
   * (like CameraController) so it fires even when hovering empty canvas.
   */
  private setupMouseTracking() {
    if (!this.app?.canvas) return;
    const canvas = this.app.canvas as HTMLCanvasElement;
    this._pointerMoveHandler = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const globalX = e.clientX - rect.left;
      const globalY = e.clientY - rect.top;
      const world = this.viewport.toLocal({ x: globalX, y: globalY });
      for (const entity of this._beings.values()) {
        entity.setMouseWorldPosition(world.x, world.y);
      }
    };
    canvas.addEventListener("pointermove", this._pointerMoveHandler);
  }

  private idSetsDiffer<T extends { id: string }>(old: T[], next: T[]): boolean {
    if (old.length !== next.length) return true;
    const oldIds = new Set(old.map((i) => i.id));
    return next.some((i) => !oldIds.has(i.id));
  }
}
