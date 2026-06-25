import type { DatabaseContext } from "@sunpilot/storage";

export interface PruneResult {
  deletedSoftDeleted: number;
  deletedExpired: number;
  deletedSuperseded: number;
  totalDeleted: number;
}

/**
 * MemoryPruningWorker — periodically physically removes memories that
 * have been soft-deleted, expired, or superseded beyond their retention
 * periods. This keeps the pgvector HNSW index lean and prevents
 * unbounded DB growth.
 */
export class MemoryPruningWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly deps: {
      database: DatabaseContext;
      intervalMs?: number;
      softDeleteRetentionDays?: number;
      expireRetentionDays?: number;
      supersedeRetentionDays?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 3_600_000; // 1 hour default
    this.timer = setInterval(() => this.prune(), interval);
    // A17: unref so the timer doesn't keep the event loop alive, allowing
    // the daemon to exit gracefully during shutdown.
    this.timer.unref();
    console.log(
      `[memory-pruning] Worker started — interval=${interval}ms ` +
      `softDeleteRetention=${this.deps.softDeleteRetentionDays ?? 30}d ` +
      `expireRetention=${this.deps.expireRetentionDays ?? 7}d ` +
      `supersedeRetention=${this.deps.supersedeRetentionDays ?? 90}d`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[memory-pruning] Worker stopped");
    }
  }

  private async prune(): Promise<PruneResult> {
    if (this.running) return { deletedSoftDeleted: 0, deletedExpired: 0, deletedSuperseded: 0, totalDeleted: 0 };
    this.running = true;
    const result: PruneResult = {
      deletedSoftDeleted: 0,
      deletedExpired: 0,
      deletedSuperseded: 0,
      totalDeleted: 0,
    };

    try {
      const now = new Date();

      // Soft-deleted memories: retain for N days before hard delete
      const softDeleteRetention =
        this.deps.softDeleteRetentionDays ?? 30;
      const softDeleteCutoff = new Date(
        now.getTime() - softDeleteRetention * 86400_000,
      ).toISOString();
      result.deletedSoftDeleted =
        await this.deps.database.memory.hardDeleteOlderThan(
          "deleted_at",
          softDeleteCutoff,
        );

      // Expired memories: retain for N days past expiration before hard delete
      const expireRetention = this.deps.expireRetentionDays ?? 7;
      const expireCutoff = new Date(
        now.getTime() - expireRetention * 86400_000,
      ).toISOString();
      result.deletedExpired =
        await this.deps.database.memory.hardDeleteOlderThan(
          "expires_at",
          expireCutoff,
        );

      // Superseded memories: retain for N days before hard delete.
      // superseded_by stores a UUID (not a timestamp), so we prune based on
      // updated_at when superseded_by IS NOT NULL.
      const supersedeRetention = this.deps.supersedeRetentionDays ?? 90;
      const supersedeCutoff = new Date(
        now.getTime() - supersedeRetention * 86400_000,
      ).toISOString();
      result.deletedSuperseded =
        await this.deps.database.memory.hardDeleteSupersededOlderThan(
          supersedeCutoff,
        );

      result.totalDeleted =
        result.deletedSoftDeleted +
        result.deletedExpired +
        result.deletedSuperseded;

      if (result.totalDeleted > 0) {
        console.log(
          `[memory-pruning] Cleared ${result.totalDeleted} memories ` +
          `(softDeleted=${result.deletedSoftDeleted} expired=${result.deletedExpired} superseded=${result.deletedSuperseded})`,
        );
      }
    } catch (err) {
      console.error(
        "[memory-pruning] Prune failed:",
        (err as Error).message,
      );
    } finally {
      this.running = false;
    }

    return result;
  }
}
