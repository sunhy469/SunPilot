import type { DatabaseContext } from "@sunpilot/storage";
import type { SummaryStaleDetector } from "@sunpilot/core";

/**
 * StaleDetectionWorker — periodically scans conversation_summary memories
 * and marks them as stale when the underlying conversation has changed.
 *
 * Uses the existing SummaryStaleDetector pattern matcher to check for
 * goal-change, correction, fact-change, and preference-conflict signals.
 */
export class StaleDetectionWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  /** Cursor for paginated scans — tracks the last processed summary so we
   *  don't re-scan the same items every cycle. Reset to null when exhausted. */
  private scanCursor: { createdAt: string; id: string } | null = null;

  private static readonly SCAN_BUDGET = 200;
  private static readonly PAGE_SIZE = 50;

  constructor(
    private readonly deps: {
      database: DatabaseContext;
      staleDetector: SummaryStaleDetector;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.timer) return;
    const interval = this.deps.intervalMs ?? 300_000; // 5 min default
    this.timer = setInterval(() => this.scan(), interval);
    // A17: unref timers so they don't keep the event loop alive, allowing
    // the daemon to exit gracefully during shutdown.
    this.timer.unref();
    // Run first scan after 30s to avoid competing with startup
    this.initialTimer = setTimeout(() => this.scan(), 30_000);
    this.initialTimer.unref();
    console.log(
      `[stale-detection] Worker started — interval=${interval}ms`,
    );
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[stale-detection] Worker stopped");
    }
  }

  private async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let processed = 0;
      let markedCount = 0;

      while (processed < StaleDetectionWorker.SCAN_BUDGET) {
        const summaries = await this.deps.database.memory.list({
          types: ["conversation_summary"],
          limit: StaleDetectionWorker.PAGE_SIZE,
          afterCursor: this.scanCursor ?? undefined,
        });

        if (summaries.length === 0) {
          this.scanCursor = null;
          break;
        }

        for (const summary of summaries) {
          if (processed >= StaleDetectionWorker.SCAN_BUDGET) break;
          processed++;

          if (summary.staleReason) continue;

          const runId = summary.runId;
          const conversationId = summary.scopeId;
          if (!runId || !conversationId) continue;

          try {
            const recentMsgs =
              await this.deps.database.messages.listByConversationId(
                conversationId,
              );
            const summaryCreatedAt = summary.createdAt;
            const newerMsgs = recentMsgs.filter(
              (m) => m.createdAt > summaryCreatedAt,
            );

            if (newerMsgs.length === 0) continue;

            const staleResult = this.deps.staleDetector.checkStale({
              summary: {
                id: summary.id,
                content: summary.content ?? summary.title ?? "",
                metadata:
                  summary.metadata as Record<string, unknown> | undefined,
                createdAt: summary.createdAt,
              },
              newMessages: newerMsgs.map((m) => ({
                role: m.role,
                content: m.content,
              })),
            });

            if (staleResult.stale) {
              await this.deps.database.memory.update(summary.id, {
                staleReason:
                  staleResult.reasons.join("; ") || "conversation_changed",
                staleSince: new Date().toISOString(),
              } as any);
              markedCount++;
            }
          } catch (err) {
            console.warn(
              `[stale-detection] Failed to check summary ${summary.id}: ${(err instanceof Error ? err.message : String(err))}`,
            );
          }
        }

        // Advance cursor to the oldest item in this page (last in DESC order)
        const last = summaries[summaries.length - 1]!;
        this.scanCursor = { createdAt: last.createdAt, id: last.id };

        if (summaries.length < StaleDetectionWorker.PAGE_SIZE) {
          this.scanCursor = null;
          break;
        }
      }

      if (markedCount > 0) {
        console.log(
          `[stale-detection] Marked ${markedCount} summaries as stale`,
        );
      }
    } catch (err) {
      console.error(
        "[stale-detection] Scan failed:",
        (err as Error).message,
      );
    } finally {
      this.running = false;
    }
  }
}
