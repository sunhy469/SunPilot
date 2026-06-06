/**
 * AbortRegistry — maps runId → AbortController for real chat.stop.
 * Replaces the placeholder { stopped: true } implementation.
 */
export class AbortRegistry {
  private controllers = new Map<string, AbortController>();

  /** Create an AbortSignal for a run. Returns a fresh signal each call. */
  create(runId: string): AbortSignal {
    // If a controller already exists for this run (e.g., from a previous
    // incomplete cleanup), abort it first to avoid leaks.
    this.abort(runId);
    const controller = new AbortController();
    this.controllers.set(runId, controller);
    return controller.signal;
  }

  /** Abort a run by its id. Returns true if a controller was found and aborted. */
  abort(runId: string): boolean {
    const controller = this.controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(runId);
    return true;
  }

  /** Remove the controller without aborting. Use when a run completes normally. */
  remove(runId: string): void {
    this.controllers.delete(runId);
  }

  /** Check if a run has an active abort controller. */
  has(runId: string): boolean {
    return this.controllers.has(runId);
  }

  /** Number of active abort controllers. */
  get size(): number {
    return this.controllers.size;
  }
}
