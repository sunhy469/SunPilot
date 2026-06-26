// Task 16 (§9.5.6): sound effects via the Web Audio API.
//
// Each event (arrive / start work / complete / error) plays a short
// oscillator beep — no external audio assets required. The AudioContext is
// created lazily on the first play() call so it respects the browser's
// user-gesture requirement. A global mute flag lets settings silence all
// sounds without unwiring the call sites.

type SoundEvent = "arrive" | "startWork" | "complete" | "error";

export class SoundManager {
  private ctx: AudioContext | null = null;
  private _muted = false;

  get muted(): boolean {
    return this._muted;
  }

  /** Mute/unmute all sounds. When muted, play() is a no-op. */
  setMuted(muted: boolean) {
    this._muted = muted;
  }

  /** Play the sound for a given event (no-op when muted). */
  play(event: SoundEvent) {
    if (this._muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    // Resume the context if it was suspended (e.g. after a tab switch).
    if (ctx.state === "suspended") {
      void ctx.resume();
    }

    switch (event) {
      case "arrive":
        // Two-tone rising beep — "arrived".
        this.beep(ctx, 523.25, 0, 0.08, 0.12);
        this.beep(ctx, 783.99, 0.08, 0.12, 0.12);
        break;
      case "startWork":
        // Single mid-tone blip.
        this.beep(ctx, 587.33, 0, 0.1, 0.1);
        break;
      case "complete":
        // Rising arpeggio — "done".
        this.beep(ctx, 523.25, 0, 0.08, 0.12);
        this.beep(ctx, 659.25, 0.08, 0.08, 0.12);
        this.beep(ctx, 783.99, 0.16, 0.14, 0.12);
        break;
      case "error":
        // Low descending buzz.
        this.beep(ctx, 220.0, 0, 0.18, 0.15);
        this.beep(ctx, 155.56, 0.12, 0.2, 0.15);
        break;
    }
  }

  /** Release the AudioContext (call on teardown). */
  destroy() {
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    return this.ctx;
  }

  /**
   * Schedule a single oscillator beep.
   * @param ctx     the audio context
   * @param freq    oscillator frequency in Hz
   * @param startAt offset (seconds) from "now" to start the beep
   * @param duration beep duration in seconds
   * @param gain    peak gain (0..1)
   */
  private beep(ctx: AudioContext, freq: number, startAt: number, duration: number, gain: number) {
    const t0 = ctx.currentTime + startAt;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t0);
    // Simple attack/decay envelope so beeps don't click.
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }
}
