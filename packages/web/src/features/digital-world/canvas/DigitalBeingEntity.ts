import { Container, FillGradient, Graphics, Ticker } from "pixi.js";

// ── Size — Q-style cuter proportions (1:1.2 head-to-body ratio) ──
// Anchor is at the center-bottom of the tracks (y = 0). All body parts
// extend upward into negative y space.
const BEING_WIDTH = 50;
const BEING_HEIGHT = 64;

// ── Layout ──────────────────────────────────────────────
const TRACK_HEIGHT = 9;
const TRACK_WIDTH = 11;
const LEFT_TRACK_X = -BEING_WIDTH / 2; // -25
const RIGHT_TRACK_X = BEING_WIDTH / 2 - TRACK_WIDTH; // 14
const WHEEL_RADIUS = 2.6;
const WHEELS_PER_TRACK = 3;
const TRACK_TREAD_SPACING = 2.4; // distance between tread segments

// Body — slightly shorter than head for cuter proportions
const BODY_WIDTH = 30;
const BODY_HEIGHT = 20;
const BODY_Y = -(TRACK_HEIGHT + BODY_HEIGHT); // -29

// Arms — jointed (upper arm + forearm)
const ARM_UPPER_LENGTH = 8;
const ARM_FOREARM_LENGTH = 7;
const ARM_WIDTH = 4.2;
const ARM_SHOULDER_Y = BODY_Y + 3; // top of arms
const ARM_SHOULDER_X = BODY_WIDTH / 2 - 1;

// Head — larger for Q-style (1:1.2 head-to-body means head ~ body height)
const HEAD_WIDTH = 32;
const HEAD_HEIGHT = 24;
const HEAD_Y = BODY_Y - 2 - HEAD_HEIGHT; // -55

// Eyes — bigger with pupils
const EYE_RADIUS = 4.2;
const PUPIL_RADIUS = 2;
const EYE_SPACING = 11;
const EYE_Y = HEAD_Y + HEAD_HEIGHT / 2 + 1; // slightly below center for cuter look

const STATUS_LIGHT_RADIUS = 2.6;
const STATUS_LIGHT_Y = HEAD_Y - STATUS_LIGHT_RADIUS - 2; // -60

// ── Colors (gradient-friendly base palette) ───────────
const SHADOW_COLOR = 0x000000;
const SHADOW_ALPHA = 0.18;

// Tracks — dark steel with tread highlights
const TRACK_COLOR = 0x1e293b;
const TRACK_TREAD_COLOR = 0x334155;
const WHEEL_COLOR = 0x0f172a;
const WHEEL_HUB_COLOR = 0x475569;

// Body — soft blue-gray gradient (top lighter, bottom darker)
const BODY_COLOR_TOP = 0xb8c2cf;
const BODY_COLOR_BOTTOM = 0x7d8a9c;
const BODY_ACCENT_COLOR = 0xe2e8f0;
const BODY_HIGHLIGHT_COLOR = 0xffffff;

// Arms — slightly darker than body for separation
const ARM_COLOR = 0x64748b;
const ARM_JOINT_COLOR = 0x475569;

// Head — darker screen-like face with bright bezel
const HEAD_COLOR_TOP = 0x475569;
const HEAD_COLOR_BOTTOM = 0x1e293b;
const HEAD_SCREEN_COLOR = 0x0f172a;
const HEAD_SCREEN_HIGHLIGHT = 0x1e293b;
const HEAD_BEZEL_COLOR = 0x64748b;

// Eye colors per state
const EYE_COLOR_DEFAULT = 0xffffff;
const EYE_COLOR_WAITING = 0xfbbf24;
const EYE_COLOR_WORKING = 0x93c5fd;
const EYE_COLOR_ERROR = 0xfca5a5;
const PUPIL_COLOR = 0x0f172a;
const EYE_CLOSED_COLOR = 0x64748b;

// Status light
const STATUS_GREEN = 0x10b981;
const STATUS_YELLOW = 0xf59e0b;
const STATUS_RED = 0xef4444;
const STATUS_OFF = 0x374151;
const STATUS_BLUE = 0x3b82f6;

// ── Animation constants ──────────────────────────────
const IDLE_BREATH_AMPLITUDE = 1.0;
const IDLE_BREATH_SPEED = 0.04;
const MOVE_BOB_AMPLITUDE = 2.2;
const MOVE_BOB_SPEED = 0.18;
const BLINK_INTERVAL_MIN = 180; // frames between blinks
const BLINK_INTERVAL_MAX = 360;
const BLINK_DURATION = 8; // frames a blink lasts
const WORKING_ARM_SPEED = 0.35;
const MOUSE_FOLLOW_MAX_OFFSET = 1.6;

type BeingStatus = "idle" | "moving" | "working" | "waiting" | "sleeping" | "error" | "publishing";
type FacingDirection = "left" | "right" | "front";

// ── State transition animation (Task 9, §9.5.8) ──────────────────────
// Smooth transitions between states using the PixiJS ticker.
interface TransitionSpec {
  duration: number; // seconds
  fromScaleY: number;
  toScaleY: number;
  bump: number; // mid-transition sin bump amplitude (positive = stretch up, negative = settle down)
}

interface TransitionState extends TransitionSpec {
  elapsed: number;
  onComplete: () => void;
}

// ease-in-out cubic: slow start and end, fast middle
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

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

  // Mouse-follow target in world coordinates (null = neutral)
  private _mouseWorldX: number | null = null;
  private _mouseWorldY: number | null = null;
  // Camera zoom factor that influences dynamic shadow sizing (1 = default)
  private _shadowZoom = 1;

  // Animation state
  private _animFrame = 0;
  private _animCallback: ((ticker: Ticker) => void) | null = null;
  private _blinkCounter = 0;
  private _nextBlinkAt = BLINK_INTERVAL_MIN;
  private _blinkRemaining = 0;
  private _workingArmPhase = 0;

  // Task 9: state transition animation state
  private _transition: TransitionState | null = null;
  private _transitionCallback: ((ticker: Ticker) => void) | null = null;

  // §9.2.2: use the app-specific ticker (passed in from WorldApp) instead of
  // Ticker.shared so animation callbacks are cleaned up automatically when the
  // app is destroyed and don't leak across mounts.
  constructor(private readonly ticker: Ticker) {
    this.container = new Container();
    this.draw();
  }

  setPosition(x: number, y: number) {
    this.container.x = x;
    this.container.y = y;
    this.redrawShadow();
    this.redrawEyes(); // pupils may shift slightly with position
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
      this.stopTransition();

      const startNextAnim = () => {
        if (this._status === "idle") this.playIdle();
        else if (this._status === "moving") this.playMove();
        else if (this._status === "sleeping") this.playSleep();
        else if (this._status === "working" || this._status === "publishing") this.playWorking();
      };

      // Task 9 (§9.5.8): run a transition animation between specific states
      // before starting the looping animation.
      const spec = this.getTransitionSpec(prev, this._status);
      if (spec) {
        this.startTransition(spec, startNextAnim);
      } else {
        startNextAnim();
      }
    }
  }

  /** Task 9: returns the transition spec for a state change, or null to switch instantly. */
  private getTransitionSpec(from: BeingStatus, to: BeingStatus): TransitionSpec | null {
    if (from === "idle" && to === "moving") {
      // Stand-up: crouch → upright (0.3s)
      return { duration: 0.3, fromScaleY: 0.85, toScaleY: 1.0, bump: 0 };
    }
    if (from === "moving" && (to === "working" || to === "publishing")) {
      // Arrive + position: settle down into working pose (0.5s)
      return { duration: 0.5, fromScaleY: 1.0, toScaleY: 1.0, bump: -0.08 };
    }
    if ((from === "working" || from === "publishing") && to === "idle") {
      // Stretch: reach up then settle (0.3s)
      return { duration: 0.3, fromScaleY: 1.0, toScaleY: 1.0, bump: 0.1 };
    }
    if (from === "idle" && to === "sleeping") {
      // Sit down + close eyes (0.8s)
      return { duration: 0.8, fromScaleY: 1.0, toScaleY: 0.7, bump: 0 };
    }
    return null;
  }

  private startTransition(spec: TransitionSpec, onComplete: () => void) {
    this.stopTransition();
    // Snap to the starting scale so the transition is visible.
    this.container.scale.y = spec.fromScaleY;
    this._transition = { ...spec, elapsed: 0, onComplete };
    this._transitionCallback = (ticker) => {
      this.runTransition(ticker);
    };
    this.ticker.add(this._transitionCallback);
  }

  private runTransition(ticker: Ticker) {
    const tr = this._transition;
    if (!tr) return;
    tr.elapsed += ticker.deltaMS / 1000;
    const t = Math.min(1, tr.elapsed / tr.duration);
    const eased = easeInOutCubic(t);
    // Base interpolation between from/to scale plus a mid-transition sin bump.
    let scale = tr.fromScaleY + (tr.toScaleY - tr.fromScaleY) * eased;
    scale += tr.bump * Math.sin(t * Math.PI);
    this.container.scale.y = scale;

    if (t >= 1) {
      this.container.scale.y = tr.toScaleY;
      const cb = tr.onComplete;
      this.stopTransition();
      cb();
    }
  }

  private stopTransition() {
    if (this._transitionCallback) {
      this.ticker.remove(this._transitionCallback);
      this._transitionCallback = null;
    }
    this._transition = null;
  }

  /** Set working progress (0-1). Shows a progress bar above the body. */
  setWorkingProgress(progress: number) {
    this._workingProgress = Math.max(0, Math.min(1, progress));
    this.redrawProgress();
  }

  /** Update mouse world position for eye-tracking. Pass nulls to clear. */
  setMouseWorldPosition(x: number | null, y: number | null) {
    this._mouseWorldX = x;
    this._mouseWorldY = y;
    this.redrawEyes();
  }

  /** Update shadow scale based on camera zoom (1 = default). */
  setShadowScale(zoom: number) {
    this._shadowZoom = Math.max(0.4, Math.min(2.0, zoom));
    this.redrawShadow();
  }

  playIdle() {
    this.stopAnimation();
    this._animFrame = 0;
    this._animCallback = () => {
      this._animFrame++;
      this.tickBlink();
      // Gentle breathing: body Y oscillates slightly
      const breathOffset = Math.sin(this._animFrame * IDLE_BREATH_SPEED) * IDLE_BREATH_AMPLITUDE;
      this.bodyLayer.y = breathOffset;
      this.headLayer.y = breathOffset;
      this.armLayer.y = breathOffset;
      this.eyeLayer.y = breathOffset;
      this.statusLightLayer.y = breathOffset;
      // Shadow scales subtly with breath (squash when "exhaling" up)
      this.shadowLayer.scale.set(1 - breathOffset * 0.04, 1 - breathOffset * 0.04);
    };
    this.ticker.add(this._animCallback);
  }

  playMove() {
    this.stopAnimation();
    this._animFrame = 0;
    this._animCallback = () => {
      this._animFrame++;
      this.tickBlink();
      // Bobbing motion: body bounces up/down more vigorously
      const bobOffset = Math.sin(this._animFrame * MOVE_BOB_SPEED) * MOVE_BOB_AMPLITUDE;
      this.bodyLayer.y = bobOffset;
      this.headLayer.y = bobOffset;
      this.armLayer.y = bobOffset;
      this.eyeLayer.y = bobOffset;
      this.statusLightLayer.y = bobOffset;

      // Dynamic shadow: smaller/lighter when being is "up"
      const shadowScale = 1 - (bobOffset / MOVE_BOB_AMPLITUDE) * 0.18;
      this.shadowLayer.scale.set(shadowScale, shadowScale);
      this.shadowLayer.alpha = 0.8 - (bobOffset / MOVE_BOB_AMPLITUDE) * 0.25;

      // Animate wheel rotation by shifting wheel positions
      this.redrawTrackWheels(this._animFrame);
    };
    this.ticker.add(this._animCallback);
  }

  playSleep() {
    this.stopAnimation();
    this._blinkCounter = 0;
    this._animCallback = () => {
      this._blinkCounter++;
      // Slow gentle sway
      const swayOffset = Math.sin(this._blinkCounter * 0.015) * 0.8;
      this.bodyLayer.y = swayOffset;
      this.headLayer.y = swayOffset;
      this.armLayer.y = swayOffset;
      this.eyeLayer.y = swayOffset;
      this.statusLightLayer.y = swayOffset;

      // Slow breath-like shadow pulse
      const shadowScale = 1 + Math.sin(this._blinkCounter * 0.015) * 0.05;
      this.shadowLayer.scale.set(shadowScale, shadowScale);

      // Blink status light slowly
      if (this._blinkCounter % 120 < 60) {
        this.statusLightLayer.alpha = 0.3;
      } else {
        this.statusLightLayer.alpha = 0.15;
      }
    };
    this.ticker.add(this._animCallback);
  }

  playWorking() {
    this.stopAnimation();
    this._animFrame = 0;
    this._workingArmPhase = 0;
    this._animCallback = () => {
      this._animFrame++;
      this.tickBlink();
      // Subtle vibration on body
      const vibX = (Math.random() - 0.5) * 0.6;
      const vibY = (Math.random() - 0.5) * 0.4;
      this.bodyLayer.x = vibX;
      this.bodyLayer.y = vibY;
      this.headLayer.x = vibX;
      this.headLayer.y = vibY;
      this.eyeLayer.x = vibX;
      this.eyeLayer.y = vibY;
      this.statusLightLayer.x = vibX;
      this.statusLightLayer.y = vibY;

      // Jointed arm typing animation
      this._workingArmPhase += WORKING_ARM_SPEED;
      this.redrawArms(this._workingArmPhase);

      // Blink status light
      const blinkOn = Math.sin(this._animFrame * 0.1) > 0;
      this.statusLightLayer.alpha = blinkOn ? 0.9 : 0.3;
    };
    this.ticker.add(this._animCallback);
  }

  private _destroyed = false;

  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this.stopAnimation();
    this.container.destroy({ children: true });
  }

  // ── Animation helpers ───────────────────────────────

  private stopAnimation() {
    if (this._animCallback) {
      this.ticker.remove(this._animCallback);
      this._animCallback = null;
    }
    // §FIX: guard against double-destroy — if the container was already
    // torn down, the Graphics layers are null and setting .x crashes.
    if (this._destroyed || this.container.destroyed) return;
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
    this.shadowLayer.alpha = 1;
    this.shadowLayer.scale.set(1, 1);
  }

  /** Drives the periodic blink animation. Should be called every frame. */
  private tickBlink() {
    if (this._blinkRemaining > 0) {
      this._blinkRemaining--;
      if (this._blinkRemaining === 0) {
        // Schedule next blink at a randomized interval
        this._nextBlinkAt =
          this._animFrame +
          BLINK_INTERVAL_MIN +
          Math.floor(Math.random() * (BLINK_INTERVAL_MAX - BLINK_INTERVAL_MIN));
        this.redrawEyes();
      } else if (this._blinkRemaining === BLINK_DURATION - 1) {
        // First frame of blink — close eyes
        this.redrawEyes();
      } else if (this._blinkRemaining === Math.floor(BLINK_DURATION / 2)) {
        // Mid-blink — eyes stay closed, no redraw needed
      }
    } else if (this._animFrame >= this._nextBlinkAt) {
      this._blinkRemaining = BLINK_DURATION;
      this.redrawEyes();
    }
  }

  private isBlinking(): boolean {
    return this._blinkRemaining > 0 && this._status !== "sleeping";
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
    this.redrawShadow();
    this.container.addChild(this.shadowLayer);
  }

  private redrawShadow() {
    this.shadowLayer.clear();
    // Dynamic shadow: ellipse under the being, scaled by zoom.
    // When zoomed in (zoom > 1), shadow grows slightly; zoomed out, shrinks.
    const baseRx = 22;
    const baseRy = 4.5;
    const rx = baseRx * (0.85 + this._shadowZoom * 0.15);
    const ry = baseRy * (0.85 + this._shadowZoom * 0.15);
    this.shadowLayer.ellipse(0, 2, rx, ry);
    this.shadowLayer.fill({ color: SHADOW_COLOR, alpha: SHADOW_ALPHA });
  }

  private drawTracks() {
    this.trackLayer = new Graphics();
    this.redrawTrackWheels(0);
    this.container.addChild(this.trackLayer);
  }

  /** Redraw tracks including treads + wheels. Pass a frame counter for wheel rotation. */
  private redrawTrackWheels(frame: number) {
    this.trackLayer.clear();

    // ── Left track base with rounded rect ──
    this.trackLayer.roundRect(LEFT_TRACK_X, -TRACK_HEIGHT, TRACK_WIDTH, TRACK_HEIGHT, 2.5);
    this.trackLayer.fill({ color: TRACK_COLOR });

    // ── Right track base ──
    this.trackLayer.roundRect(RIGHT_TRACK_X, -TRACK_HEIGHT, TRACK_WIDTH, TRACK_HEIGHT, 2.5);
    this.trackLayer.fill({ color: TRACK_COLOR });

    // ── Tread texture: small dashes along the bottom edge of each track ──
    // The dashes shift with the frame counter to give a "rolling tread" look.
    const treadOffset = (frame * 0.6) % TRACK_TREAD_SPACING;
    const treadW = 1.4;
    const treadH = TRACK_HEIGHT - 3;
    for (let tx = LEFT_TRACK_X + treadOffset; tx < LEFT_TRACK_X + TRACK_WIDTH - 1; tx += TRACK_TREAD_SPACING) {
      this.trackLayer.rect(tx, -TRACK_HEIGHT + 1.5, treadW, treadH);
      this.trackLayer.fill({ color: TRACK_TREAD_COLOR, alpha: 0.65 });
    }
    for (let tx = RIGHT_TRACK_X + treadOffset; tx < RIGHT_TRACK_X + TRACK_WIDTH - 1; tx += TRACK_TREAD_SPACING) {
      this.trackLayer.rect(tx, -TRACK_HEIGHT + 1.5, treadW, treadH);
      this.trackLayer.fill({ color: TRACK_TREAD_COLOR, alpha: 0.65 });
    }

    // ── Wheels — animated rotation by shifting positions ──
    // We approximate "rotation" by translating wheel positions along the track.
    const wheelShift = (frame * 0.5) % (TRACK_WIDTH / (WHEELS_PER_TRACK + 1));
    const spacing = TRACK_WIDTH / (WHEELS_PER_TRACK + 1);

    const drawWheel = (wx: number, wy: number) => {
      // Outer tire
      this.trackLayer.circle(wx, wy, WHEEL_RADIUS);
      this.trackLayer.fill({ color: WHEEL_COLOR });
      // Hub highlight (gives a sense of rotation when offset)
      this.trackLayer.circle(wx + Math.sin(frame * 0.3) * 0.6, wy + Math.cos(frame * 0.3) * 0.6, WHEEL_RADIUS * 0.4);
      this.trackLayer.fill({ color: WHEEL_HUB_COLOR, alpha: 0.8 });
    };

    for (let i = 0; i < WHEELS_PER_TRACK; i++) {
      const wx = LEFT_TRACK_X + ((spacing * (i + 1) + wheelShift) % TRACK_WIDTH);
      drawWheel(wx, -TRACK_HEIGHT / 2);
    }
    for (let i = 0; i < WHEELS_PER_TRACK; i++) {
      const wx = RIGHT_TRACK_X + ((spacing * (i + 1) + wheelShift) % TRACK_WIDTH);
      drawWheel(wx, -TRACK_HEIGHT / 2);
    }
  }

  private drawBody() {
    this.bodyLayer = new Graphics();
    const bx = -BODY_WIDTH / 2;

    // Main body rounded rect with vertical gradient (lighter top, darker bottom)
    this.bodyLayer.roundRect(bx, BODY_Y, BODY_WIDTH, BODY_HEIGHT, 6);
    this.bodyLayer.fill(this.makeBodyGradient());

    // Side bevel highlight (left edge)
    this.bodyLayer.roundRect(bx + 1, BODY_Y + 1, 2, BODY_HEIGHT - 2, 1);
    this.bodyLayer.fill({ color: BODY_HIGHLIGHT_COLOR, alpha: 0.35 });

    // Accent stripe across middle (chest plate)
    const stripeY = BODY_Y + BODY_HEIGHT * 0.45;
    this.bodyLayer.roundRect(bx + 4, stripeY, BODY_WIDTH - 8, 2.5, 1);
    this.bodyLayer.fill({ color: BODY_ACCENT_COLOR, alpha: 0.7 });

    // Tiny chest indicator dot (state-colored, mirrors status light)
    const chestColor = this.getStatusColor();
    this.bodyLayer.circle(0, BODY_Y + BODY_HEIGHT * 0.28, 1.6);
    this.bodyLayer.fill({ color: chestColor, alpha: 0.9 });

    this.container.addChild(this.bodyLayer);
  }

  private makeBodyGradient() {
    // Vertical gradient (lighter top, darker bottom). Coordinates are in
    // local space (0..1). A fresh gradient per redraw is fine for a single
    // small entity.
    return new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: BODY_COLOR_TOP },
        { offset: 1, color: BODY_COLOR_BOTTOM },
      ],
    });
  }

  private drawArms() {
    this.armLayer = new Graphics();
    this.redrawArms();
    this.container.addChild(this.armLayer);
  }

  /**
   * Draw jointed arms. When workingPhase is provided, forearms animate to
   * simulate typing/operating motion.
   */
  private redrawArms(workingPhase?: number) {
    this.armLayer.clear();

    const isWorking = this._status === "working" || this._status === "publishing";
    // Typing oscillation: forearm angle wiggles up and down
    const typingAngle = isWorking && workingPhase !== undefined
      ? Math.sin(workingPhase) * 0.45 // radians, ~±26°
      : 0;
    // Forearm angle at rest: slight outward bend
    const restAngle = 0.25; // radians, ~14° outward
    const forearmAngle = isWorking ? typingAngle : restAngle;

    // Right arm (drawn in local space; container flips for facing)
    this.drawJointedArm(ARM_SHOULDER_X, ARM_SHOULDER_Y, forearmAngle, false);
    // Left arm
    this.drawJointedArm(-ARM_SHOULDER_X, ARM_SHOULDER_Y, forearmAngle, true);
  }

  /**
   * Draw a single jointed arm: upper arm hangs down, forearm bends outward
   * (or wiggles when typing).
   */
  private drawJointedArm(shoulderX: number, shoulderY: number, forearmAngle: number, isLeft: boolean) {
    const dir = isLeft ? -1 : 1;
    // Upper arm: from shoulder downward
    const elbowX = shoulderX;
    const elbowY = shoulderY + ARM_UPPER_LENGTH;

    // Forearm: bends outward (away from body) by forearmAngle
    const foreEndX = elbowX + dir * Math.sin(forearmAngle) * ARM_FOREARM_LENGTH;
    const foreEndY = elbowY + Math.cos(forearmAngle) * ARM_FOREARM_LENGTH;

    // Upper arm — rounded capsule
    this.armLayer.roundRect(
      shoulderX - ARM_WIDTH / 2,
      shoulderY,
      ARM_WIDTH,
      ARM_UPPER_LENGTH,
      ARM_WIDTH / 2,
    );
    this.armLayer.fill({ color: ARM_COLOR });

    // Joint (elbow) — small circle for visual joint
    this.armLayer.circle(elbowX, elbowY, ARM_WIDTH / 2 + 0.4);
    this.armLayer.fill({ color: ARM_JOINT_COLOR });

    // Forearm — rotated capsule drawn as a polygon
    const halfW = ARM_WIDTH / 2;
    // Perpendicular to forearm direction: forearm dir = (foreEndX - elbowX, foreEndY - elbowY)
    const fdx = foreEndX - elbowX;
    const fdy = foreEndY - elbowY;
    const flen = Math.hypot(fdx, fdy) || 1;
    const nx = -fdy / flen;
    const ny = fdx / flen;

    // Draw forearm as a quad with rounded end caps (approx)
    this.armLayer.moveTo(elbowX + nx * halfW, elbowY + ny * halfW);
    this.armLayer.lineTo(elbowX - nx * halfW, elbowY - ny * halfW);
    this.armLayer.lineTo(foreEndX - nx * halfW, foreEndY - ny * halfW);
    this.armLayer.lineTo(foreEndX + nx * halfW, foreEndY + ny * halfW);
    this.armLayer.closePath();
    this.armLayer.fill({ color: ARM_COLOR });

    // Hand (small circle at the end)
    this.armLayer.circle(foreEndX, foreEndY, halfW + 0.5);
    this.armLayer.fill({ color: ARM_JOINT_COLOR });
  }

  private drawHead() {
    this.headLayer = new Graphics();
    const hx = -HEAD_WIDTH / 2;

    // Outer bezel/border (1px larger, lighter)
    this.headLayer.roundRect(hx - 1.5, HEAD_Y - 1.5, HEAD_WIDTH + 3, HEAD_HEIGHT + 3, 8);
    this.headLayer.fill({ color: HEAD_BEZEL_COLOR });

    // Head main with vertical gradient (top lighter, bottom darker)
    this.headLayer.roundRect(hx, HEAD_Y, HEAD_WIDTH, HEAD_HEIGHT, 7);
    this.headLayer.fill(this.makeHeadGradient());

    // Screen area (face) inset
    const pad = 3;
    const screenX = hx + pad;
    const screenY = HEAD_Y + pad;
    const screenW = HEAD_WIDTH - pad * 2;
    const screenH = HEAD_HEIGHT - pad * 2;
    this.headLayer.roundRect(screenX, screenY, screenW, screenH, 4);
    this.headLayer.fill({ color: HEAD_SCREEN_COLOR });

    // Screen inner highlight (top-left, simulates glass reflection)
    this.headLayer.roundRect(screenX + 1, screenY + 1, screenW * 0.5, screenH * 0.35, 2);
    this.headLayer.fill({ color: HEAD_SCREEN_HIGHLIGHT, alpha: 0.6 });

    this.container.addChild(this.headLayer);
  }

  private makeHeadGradient() {
    return new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: HEAD_COLOR_TOP },
        { offset: 1, color: HEAD_COLOR_BOTTOM },
      ],
    });
  }

  private drawEyes() {
    this.eyeLayer = new Graphics();
    this.redrawEyes();
    this.container.addChild(this.eyeLayer);
  }

  private redrawEyes() {
    this.eyeLayer.clear();

    const lx = -EYE_SPACING / 2;
    const rx = EYE_SPACING / 2;

    // Sleeping: closed-eye horizontal lines (curved for cuter look)
    if (this._status === "sleeping") {
      this.drawClosedEye(lx);
      this.drawClosedEye(rx);
      return;
    }

    // Blinking: temporarily draw closed-eye curves
    if (this.isBlinking()) {
      this.drawClosedEye(lx);
      this.drawClosedEye(rx);
      return;
    }

    // Determine eye sclera color by status
    let scleraColor = EYE_COLOR_DEFAULT;
    if (this._status === "waiting") scleraColor = EYE_COLOR_WAITING;
    else if (this._status === "working" || this._status === "publishing") scleraColor = EYE_COLOR_WORKING;
    else if (this._status === "error") scleraColor = EYE_COLOR_ERROR;

    // Compute pupil offset from mouse position (mouse-follow)
    const { dx: pupilDx, dy: pupilDy } = this.computePupilOffset();

    // Left eye
    this.drawOpenEye(lx, EYE_Y, scleraColor, pupilDx, pupilDy);
    // Right eye
    this.drawOpenEye(rx, EYE_Y, scleraColor, pupilDx, pupilDy);
  }

  /** Compute pupil offset based on mouse world position relative to being. */
  private computePupilOffset(): { dx: number; dy: number } {
    if (this._mouseWorldX === null || this._mouseWorldY === null) {
      return { dx: 0, dy: 0 };
    }
    // Vector from being to mouse in world space
    let dx = this._mouseWorldX - this.container.x;
    let dy = this._mouseWorldY - this.container.y;
    // Apply facing flip on x
    if (this._facing === "left") dx = -dx;
    // Normalize and clamp
    const dist = Math.hypot(dx, dy);
    if (dist < 0.001) return { dx: 0, dy: 0 };
    const maxOffset = MOUSE_FOLLOW_MAX_OFFSET;
    const clamped = Math.min(dist / 80, 1) * maxOffset; // saturate at 80px
    return {
      dx: (dx / dist) * clamped,
      dy: (dy / dist) * clamped,
    };
  }

  /** Draw an open eye: sclera circle + pupil offset toward mouse. */
  private drawOpenEye(cx: number, cy: number, scleraColor: number, pupilDx: number, pupilDy: number) {
    // Sclera
    this.eyeLayer.circle(cx, cy, EYE_RADIUS);
    this.eyeLayer.fill({ color: scleraColor });

    // Subtle sclera highlight (top-left)
    this.eyeLayer.circle(cx - EYE_RADIUS * 0.35, cy - EYE_RADIUS * 0.35, EYE_RADIUS * 0.3);
    this.eyeLayer.fill({ color: 0xffffff, alpha: 0.7 });

    // Pupil (offset toward mouse)
    const px = cx + pupilDx;
    const py = cy + pupilDy;
    this.eyeLayer.circle(px, py, PUPIL_RADIUS);
    this.eyeLayer.fill({ color: PUPIL_COLOR });

    // Pupil glint
    this.eyeLayer.circle(px - 0.5, py - 0.5, 0.6);
    this.eyeLayer.fill({ color: 0xffffff, alpha: 0.9 });
  }

  /** Draw a closed-eye curve (sleeping or mid-blink). */
  private drawClosedEye(cx: number) {
    // Downward-curving arc (^-like, cute closed eye)
    this.eyeLayer.moveTo(cx - EYE_RADIUS, EYE_Y);
    this.eyeLayer.quadraticCurveTo(cx, EYE_Y - EYE_RADIUS * 0.7, cx + EYE_RADIUS, EYE_Y);
    this.eyeLayer.stroke({ color: EYE_CLOSED_COLOR, width: 1.6, cap: "round" });
  }

  private drawStatusLight() {
    this.statusLightLayer = new Graphics();
    this.redrawStatusLight();
    this.container.addChild(this.statusLightLayer);
  }

  private getStatusColor(): number {
    switch (this._status) {
      case "idle":
      case "moving":
        return STATUS_GREEN;
      case "working":
      case "publishing":
        return STATUS_YELLOW;
      case "waiting":
        return STATUS_YELLOW;
      case "sleeping":
        return STATUS_OFF;
      case "error":
        return STATUS_RED;
      default:
        return STATUS_GREEN;
    }
  }

  private redrawStatusLight() {
    this.statusLightLayer.clear();

    const color = this.getStatusColor();
    let alpha: number;
    switch (this._status) {
      case "working":
      case "publishing":
        alpha = 0.8;
        break;
      case "sleeping":
        alpha = 0.3;
        break;
      case "waiting":
        alpha = 1;
        break;
      default:
        alpha = 1;
    }

    // Glow halo (large soft circle)
    this.statusLightLayer.circle(0, STATUS_LIGHT_Y, STATUS_LIGHT_RADIUS + 3);
    this.statusLightLayer.fill({ color, alpha: alpha * 0.18 });

    // Mid glow
    this.statusLightLayer.circle(0, STATUS_LIGHT_Y, STATUS_LIGHT_RADIUS + 1.2);
    this.statusLightLayer.fill({ color, alpha: alpha * 0.35 });

    // Core light dot
    this.statusLightLayer.circle(0, STATUS_LIGHT_Y, STATUS_LIGHT_RADIUS);
    this.statusLightLayer.fill({ color, alpha });

    // Highlight on the dot
    this.statusLightLayer.circle(-0.6, STATUS_LIGHT_Y - 0.6, STATUS_LIGHT_RADIUS * 0.4);
    this.statusLightLayer.fill({ color: 0xffffff, alpha: 0.7 });
  }

  private drawProgress() {
    this.progressLayer = new Graphics();
    this.progressLayer.visible = false;
    this.container.addChild(this.progressLayer);
  }

  private redrawProgress() {
    this.progressLayer.clear();

    if (
      (this._status !== "working" && this._status !== "publishing") ||
      this._workingProgress <= 0
    ) {
      this.progressLayer.visible = false;
      return;
    }

    this.progressLayer.visible = true;

    const barWidth = BODY_WIDTH + 2;
    const barHeight = 3;
    const barY = BODY_Y - 5;
    const barX = -barWidth / 2;

    // Background
    this.progressLayer.roundRect(barX, barY, barWidth, barHeight, 1.5);
    this.progressLayer.fill({ color: 0xe5e7eb });

    // Fill
    const fillWidth = Math.max(barHeight, barWidth * this._workingProgress);
    this.progressLayer.roundRect(barX, barY, fillWidth, barHeight, 1.5);
    this.progressLayer.fill({ color: STATUS_BLUE });
  }
}
