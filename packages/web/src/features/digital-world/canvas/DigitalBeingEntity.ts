import { Container, Graphics, Ticker } from "pixi.js";

// ── Size ──────────────────────────────────────────────
const BEING_WIDTH = 48;
const BEING_HEIGHT = 60;

// ── Layout (anchor at center-bottom of tracks, y=0) ──
const TRACK_HEIGHT = 10;
const TRACK_WIDTH = 10;
const LEFT_TRACK_X = -BEING_WIDTH / 2; // -24
const RIGHT_TRACK_X = BEING_WIDTH / 2 - TRACK_WIDTH; // 14
const WHEEL_RADIUS = 2.5;
const WHEELS_PER_TRACK = 3;

const BODY_WIDTH = 28;
const BODY_HEIGHT = 24;
const BODY_Y = -(TRACK_HEIGHT + BODY_HEIGHT); // -34

const ARM_WIDTH = 7;
const ARM_HEIGHT = 14;

const HEAD_WIDTH = 26;
const HEAD_HEIGHT = 16;
const HEAD_Y = BODY_Y - 2 - HEAD_HEIGHT; // -52

const EYE_RADIUS = 3;
const EYE_SPACING = 9;

const STATUS_LIGHT_RADIUS = 3;
const STATUS_LIGHT_Y = HEAD_Y - STATUS_LIGHT_RADIUS - 2; // -57

// ── Colors ────────────────────────────────────────────
const SHADOW_COLOR = 0x000000;
const SHADOW_ALPHA = 0.08;
const TRACK_COLOR = 0x1e293b;
const WHEEL_COLOR = 0x0f172a;
const BODY_COLOR = 0x94a3b8;
const BODY_ACCENT_COLOR = 0xcdd5de;
const ARM_COLOR = 0x64748b;
const HEAD_COLOR = 0x334155;
const HEAD_SCREEN_COLOR = 0x475569;
const HEAD_BORDER_COLOR = 0x1e293b;
const EYE_COLOR_DEFAULT = 0xffffff;
const EYE_COLOR_WAITING = 0xfbbf24;
const EYE_CLOSED_COLOR = 0x94a3b8;
const STATUS_GREEN = 0x10b981;
const STATUS_YELLOW = 0xf59e0b;
const STATUS_RED = 0xef4444;
const STATUS_OFF = 0x374151;

// ── Animation constants ──────────────────────────────
const IDLE_BREATH_AMPLITUDE = 1.2;
const IDLE_BREATH_SPEED = 0.04;
const MOVE_BOB_AMPLITUDE = 2;
const MOVE_BOB_SPEED = 0.12;
const SLEEP_ZZZ_INTERVAL = 60; // frames between Zzz appearances

type BeingStatus = "idle" | "moving" | "working" | "waiting" | "sleeping" | "error";
type FacingDirection = "left" | "right" | "front";

export class DigitalBeingEntity {
  readonly container: Container;

  private shadowLayer!: Graphics;
  private trackLayer!: Graphics;
  private bodyLayer!: Graphics;
  private armLayer!: Graphics;
  private headLayer!: Graphics;
  private eyeLayer!: Graphics;
  private statusLightLayer!: Graphics;
  private progressLayer!: Graphics;

  private _status: BeingStatus = "idle";
  private _facing: FacingDirection = "front";
  private _workingProgress = 0;

  // Animation state
  private _animFrame = 0;
  private _animCallback: ((ticker: Ticker) => void) | null = null;
  private _sleepZzzCounter = 0;

  constructor() {
    this.container = new Container();
    this.draw();
  }

  setPosition(x: number, y: number) {
    this.container.x = x;
    this.container.y = y;
  }

  setFacing(direction: FacingDirection) {
    this._facing = direction;
    this.container.scale.x = direction === "left" ? -1 : 1;
  }

  setStatus(status: string) {
    const prev = this._status;
    this._status = status as BeingStatus;
    this.redrawEyes();
    this.redrawStatusLight();
    this.redrawArms();

    // Auto-start animations on status change
    if (prev !== this._status) {
      this.stopAnimation();
      if (this._status === "idle") this.playIdle();
      else if (this._status === "moving") this.playMove();
      else if (this._status === "sleeping") this.playSleep();
      else if (this._status === "working") this.playWorking();
    }
  }

  /** Set working progress (0-1). Shows a progress bar above the body. */
  setWorkingProgress(progress: number) {
    this._workingProgress = Math.max(0, Math.min(1, progress));
    this.redrawProgress();
  }

  playIdle() {
    this.stopAnimation();
    this._animFrame = 0;
    this._animCallback = () => {
      this._animFrame++;
      // Gentle breathing: body Y oscillates slightly
      const breathOffset = Math.sin(this._animFrame * IDLE_BREATH_SPEED) * IDLE_BREATH_AMPLITUDE;
      this.bodyLayer.y = breathOffset;
      this.headLayer.y = breathOffset;
      this.armLayer.y = breathOffset;
      this.eyeLayer.y = breathOffset;
      this.statusLightLayer.y = breathOffset;
    };
    Ticker.shared.add(this._animCallback);
  }

  playMove() {
    this.stopAnimation();
    this._animFrame = 0;
    this._animCallback = () => {
      this._animFrame++;
      // Bobbing motion: body bounces up/down more vigorously
      const bobOffset = Math.sin(this._animFrame * MOVE_BOB_SPEED) * MOVE_BOB_AMPLITUDE;
      this.bodyLayer.y = bobOffset;
      this.headLayer.y = bobOffset;
      this.armLayer.y = bobOffset;
      this.eyeLayer.y = bobOffset;
      this.statusLightLayer.y = bobOffset;

      // Animate wheel rotation by shifting wheel positions
      this.redrawTrackWheels(this._animFrame);
    };
    Ticker.shared.add(this._animCallback);
  }

  playSleep() {
    this.stopAnimation();
    this._sleepZzzCounter = 0;
    this._animCallback = () => {
      this._sleepZzzCounter++;
      // Slow gentle sway
      const swayOffset = Math.sin(this._sleepZzzCounter * 0.015) * 0.8;
      this.bodyLayer.y = swayOffset;
      this.headLayer.y = swayOffset;
      this.armLayer.y = swayOffset;
      this.eyeLayer.y = swayOffset;
      this.statusLightLayer.y = swayOffset;

      // Blink status light slowly
      if (this._sleepZzzCounter % 120 < 60) {
        this.statusLightLayer.alpha = 0.3;
      } else {
        this.statusLightLayer.alpha = 0.15;
      }
    };
    Ticker.shared.add(this._animCallback);
  }

  playWorking() {
    this.stopAnimation();
    this._animFrame = 0;
    this._animCallback = () => {
      this._animFrame++;
      // Subtle vibration
      const vibX = (Math.random() - 0.5) * 0.6;
      const vibY = (Math.random() - 0.5) * 0.4;
      this.bodyLayer.x = vibX;
      this.bodyLayer.y = vibY;
      this.headLayer.x = vibX;
      this.headLayer.y = vibY;
      this.armLayer.x = vibX;
      this.armLayer.y = vibY;
      this.eyeLayer.x = vibX;
      this.eyeLayer.y = vibY;
      this.statusLightLayer.x = vibX;
      this.statusLightLayer.y = vibY;

      // Blink status light
      const blinkOn = Math.sin(this._animFrame * 0.1) > 0;
      this.statusLightLayer.alpha = blinkOn ? 0.9 : 0.3;
    };
    Ticker.shared.add(this._animCallback);
  }

  destroy() {
    this.stopAnimation();
    this.container.destroy({ children: true });
  }

  // ── Animation helpers ───────────────────────────────

  private stopAnimation() {
    if (this._animCallback) {
      Ticker.shared.remove(this._animCallback);
      this._animCallback = null;
    }
    // Reset offsets
    this.bodyLayer.x = 0;
    this.bodyLayer.y = 0;
    this.headLayer.x = 0;
    this.headLayer.y = 0;
    this.armLayer.x = 0;
    this.armLayer.y = 0;
    this.eyeLayer.x = 0;
    this.eyeLayer.y = 0;
    this.statusLightLayer.x = 0;
    this.statusLightLayer.y = 0;
    this.statusLightLayer.alpha = 1;
  }

  private redrawTrackWheels(frame: number) {
    // Simple wheel animation: shift wheel positions slightly
    this.trackLayer.clear();

    // Left track
    this.trackLayer.roundRect(LEFT_TRACK_X, -TRACK_HEIGHT, TRACK_WIDTH, TRACK_HEIGHT, 2);
    this.trackLayer.fill({ color: TRACK_COLOR });

    // Right track
    this.trackLayer.roundRect(RIGHT_TRACK_X, -TRACK_HEIGHT, TRACK_WIDTH, TRACK_HEIGHT, 2);
    this.trackLayer.fill({ color: TRACK_COLOR });

    // Wheels with animated offset
    const wheelShift = (frame * 0.5) % (TRACK_WIDTH / (WHEELS_PER_TRACK + 1));
    const spacing = TRACK_WIDTH / (WHEELS_PER_TRACK + 1);

    for (let i = 0; i < WHEELS_PER_TRACK; i++) {
      const wx = LEFT_TRACK_X + ((spacing * (i + 1) + wheelShift) % TRACK_WIDTH);
      const wy = -TRACK_HEIGHT / 2;
      this.trackLayer.circle(wx, wy, WHEEL_RADIUS);
      this.trackLayer.fill({ color: WHEEL_COLOR });
    }
    for (let i = 0; i < WHEELS_PER_TRACK; i++) {
      const wx = RIGHT_TRACK_X + ((spacing * (i + 1) + wheelShift) % TRACK_WIDTH);
      const wy = -TRACK_HEIGHT / 2;
      this.trackLayer.circle(wx, wy, WHEEL_RADIUS);
      this.trackLayer.fill({ color: WHEEL_COLOR });
    }
  }

  // ── Drawing ─────────────────────────────────────────

  private draw() {
    this.drawShadow();
    this.drawTracks();
    this.drawBody();
    this.drawArms();
    this.drawHead();
    this.drawEyes();
    this.drawStatusLight();
    this.drawProgress();
  }

  private drawShadow() {
    this.shadowLayer = new Graphics();
    this.shadowLayer.ellipse(0, 2, 20, 4);
    this.shadowLayer.fill({ color: SHADOW_COLOR, alpha: SHADOW_ALPHA });
    this.container.addChild(this.shadowLayer);
  }

  private drawTracks() {
    this.trackLayer = new Graphics();

    // Left track
    this.trackLayer.roundRect(LEFT_TRACK_X, -TRACK_HEIGHT, TRACK_WIDTH, TRACK_HEIGHT, 2);
    this.trackLayer.fill({ color: TRACK_COLOR });

    // Right track
    this.trackLayer.roundRect(RIGHT_TRACK_X, -TRACK_HEIGHT, TRACK_WIDTH, TRACK_HEIGHT, 2);
    this.trackLayer.fill({ color: TRACK_COLOR });

    // Wheels
    const spacing = TRACK_WIDTH / (WHEELS_PER_TRACK + 1);
    for (let i = 0; i < WHEELS_PER_TRACK; i++) {
      const wx = LEFT_TRACK_X + spacing * (i + 1);
      const wy = -TRACK_HEIGHT / 2;
      this.trackLayer.circle(wx, wy, WHEEL_RADIUS);
      this.trackLayer.fill({ color: WHEEL_COLOR });
    }
    for (let i = 0; i < WHEELS_PER_TRACK; i++) {
      const wx = RIGHT_TRACK_X + spacing * (i + 1);
      const wy = -TRACK_HEIGHT / 2;
      this.trackLayer.circle(wx, wy, WHEEL_RADIUS);
      this.trackLayer.fill({ color: WHEEL_COLOR });
    }

    this.container.addChild(this.trackLayer);
  }

  private drawBody() {
    this.bodyLayer = new Graphics();
    const bx = -BODY_WIDTH / 2;

    // Main body rounded rect
    this.bodyLayer.roundRect(bx, BODY_Y, BODY_WIDTH, BODY_HEIGHT, 4);
    this.bodyLayer.fill({ color: BODY_COLOR });

    // Accent stripe across middle
    const stripeY = BODY_Y + BODY_HEIGHT * 0.45;
    this.bodyLayer.rect(bx + 3, stripeY, BODY_WIDTH - 6, 2);
    this.bodyLayer.fill({ color: BODY_ACCENT_COLOR, alpha: 0.5 });

    this.container.addChild(this.bodyLayer);
  }

  private drawArms() {
    this.armLayer = new Graphics();
    this.redrawArms();
    this.container.addChild(this.armLayer);
  }

  private redrawArms() {
    this.armLayer.clear();

    const armTopY = BODY_Y + 3;
    const bodyHalf = BODY_WIDTH / 2;
    const extended = this._status === "working" ? 3 : 0;

    // Left arm — trapezoid angled outward
    this.armLayer.moveTo(-bodyHalf, armTopY);
    this.armLayer.lineTo(-bodyHalf - ARM_WIDTH - extended, armTopY + ARM_HEIGHT);
    this.armLayer.lineTo(-bodyHalf - extended, armTopY + ARM_HEIGHT);
    this.armLayer.closePath();
    this.armLayer.fill({ color: ARM_COLOR });

    // Right arm — trapezoid angled outward
    this.armLayer.moveTo(bodyHalf, armTopY);
    this.armLayer.lineTo(bodyHalf + ARM_WIDTH + extended, armTopY + ARM_HEIGHT);
    this.armLayer.lineTo(bodyHalf + extended, armTopY + ARM_HEIGHT);
    this.armLayer.closePath();
    this.armLayer.fill({ color: ARM_COLOR });
  }

  private drawHead() {
    this.headLayer = new Graphics();
    const hx = -HEAD_WIDTH / 2;

    // Border (1px larger)
    this.headLayer.roundRect(hx - 1, HEAD_Y - 1, HEAD_WIDTH + 2, HEAD_HEIGHT + 2, 5);
    this.headLayer.fill({ color: HEAD_BORDER_COLOR });

    // Head main
    this.headLayer.roundRect(hx, HEAD_Y, HEAD_WIDTH, HEAD_HEIGHT, 4);
    this.headLayer.fill({ color: HEAD_COLOR });

    // Screen area inside
    const pad = 3;
    this.headLayer.roundRect(
      hx + pad,
      HEAD_Y + pad,
      HEAD_WIDTH - pad * 2,
      HEAD_HEIGHT - pad * 2,
      2,
    );
    this.headLayer.fill({ color: HEAD_SCREEN_COLOR });

    this.container.addChild(this.headLayer);
  }

  private drawEyes() {
    this.eyeLayer = new Graphics();
    this.redrawEyes();
    this.container.addChild(this.eyeLayer);
  }

  private redrawEyes() {
    this.eyeLayer.clear();

    const eyeY = HEAD_Y + HEAD_HEIGHT / 2;
    const lx = -EYE_SPACING / 2;
    const rx = EYE_SPACING / 2;

    switch (this._status) {
      case "sleeping":
        // Horizontal lines (closed eyes)
        this.eyeLayer.moveTo(lx - EYE_RADIUS, eyeY);
        this.eyeLayer.lineTo(lx + EYE_RADIUS, eyeY);
        this.eyeLayer.stroke({ color: EYE_CLOSED_COLOR, width: 2 });
        this.eyeLayer.moveTo(rx - EYE_RADIUS, eyeY);
        this.eyeLayer.lineTo(rx + EYE_RADIUS, eyeY);
        this.eyeLayer.stroke({ color: EYE_CLOSED_COLOR, width: 2 });
        break;

      case "waiting":
        // Yellow dots
        this.eyeLayer.circle(lx, eyeY, EYE_RADIUS - 1);
        this.eyeLayer.fill({ color: EYE_COLOR_WAITING });
        this.eyeLayer.circle(rx, eyeY, EYE_RADIUS - 1);
        this.eyeLayer.fill({ color: EYE_COLOR_WAITING });
        break;

      default:
        // Bright white eyes (idle / moving / working / error)
        this.eyeLayer.circle(lx, eyeY, EYE_RADIUS);
        this.eyeLayer.fill({ color: EYE_COLOR_DEFAULT });
        this.eyeLayer.circle(rx, eyeY, EYE_RADIUS);
        this.eyeLayer.fill({ color: EYE_COLOR_DEFAULT });
        break;
    }
  }

  private drawStatusLight() {
    this.statusLightLayer = new Graphics();
    this.redrawStatusLight();
    this.container.addChild(this.statusLightLayer);
  }

  private redrawStatusLight() {
    this.statusLightLayer.clear();

    let color: number;
    let alpha: number;

    switch (this._status) {
      case "idle":
      case "moving":
        color = STATUS_GREEN;
        alpha = 1;
        break;
      case "working":
        color = STATUS_YELLOW;
        alpha = 0.7;
        break;
      case "waiting":
        color = STATUS_YELLOW;
        alpha = 1;
        break;
      case "sleeping":
        color = STATUS_OFF;
        alpha = 0.3;
        break;
      case "error":
        color = STATUS_RED;
        alpha = 1;
        break;
      default:
        color = STATUS_GREEN;
        alpha = 1;
    }

    // Glow halo
    this.statusLightLayer.circle(0, STATUS_LIGHT_Y, STATUS_LIGHT_RADIUS + 2);
    this.statusLightLayer.fill({ color, alpha: alpha * 0.15 });

    // Light dot
    this.statusLightLayer.circle(0, STATUS_LIGHT_Y, STATUS_LIGHT_RADIUS);
    this.statusLightLayer.fill({ color, alpha });
  }

  private drawProgress() {
    this.progressLayer = new Graphics();
    this.progressLayer.visible = false;
    this.container.addChild(this.progressLayer);
  }

  private redrawProgress() {
    this.progressLayer.clear();

    if (this._status !== "working" || this._workingProgress <= 0) {
      this.progressLayer.visible = false;
      return;
    }

    this.progressLayer.visible = true;

    const barWidth = BODY_WIDTH;
    const barHeight = 3;
    const barY = BODY_Y - 4;
    const barX = -barWidth / 2;

    // Background
    this.progressLayer.roundRect(barX, barY, barWidth, barHeight, 1.5);
    this.progressLayer.fill({ color: 0xe5e7eb });

    // Fill
    const fillWidth = Math.max(barHeight, barWidth * this._workingProgress);
    this.progressLayer.roundRect(barX, barY, fillWidth, barHeight, 1.5);
    this.progressLayer.fill({ color: STATUS_GREEN });
  }
}
