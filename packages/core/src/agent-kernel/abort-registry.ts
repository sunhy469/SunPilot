/**
 * AbortRegistry — 管理 runId → AbortController 的映射，实现真正的聊天取消。
 *
 * 关键行为：
 * - create(runId)：为 run 创建新的 AbortSignal。如果已有残留的旧控制器（上次未正常清理），
 *   先 abort 旧控制器再创建新的，防止 AbortController 泄漏。
 * - abort(runId)：触发 abort 信号并删除控制器。Agent Loop 的 signal.aborted 变为 true。
 * - remove(runId)：仅删除控制器不触发 abort。用于正常完成路径的清理。
 *
 * 前端 chat.stop → JSON-RPC router → AgentService.stopChat → abortRegistry.abort(runId)。
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
