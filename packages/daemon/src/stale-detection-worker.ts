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
  private running = false;

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
    const initial = setTimeout(() => this.scan(), 30_000);
    initial.unref();
    console.log(
      `[stale-detection] Worker started — interval=${interval}ms`,
    );
  }

  stop(): void {
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
      // Fetch recent conversation summaries that haven't been marked stale
      const summaries = await this.deps.database.memory.search({
        types: ["conversation_summary"] as any,
        limit: 50,
      });

      let markedCount = 0;
      for (const summary of summaries) {
        if (summary.staleReason) continue; // Already stale

        // Get the conversation's recent messages to check for staleness
        const runId = summary.runId;
        const conversationId = summary.scopeId;
        if (!runId || !conversationId) continue;

        try {
          // Check for messages newer than the summary
          const recentMsgs =
            await this.deps.database.messages.listByConversationId(
              conversationId,
            );
          const summaryCreatedAt = summary.createdAt;
          const newerMsgs = recentMsgs.filter(
            (m) => m.createdAt > summaryCreatedAt,
          );

          if (newerMsgs.length === 0) continue;

          // Use SummaryStaleDetector to check staleness
          const staleResult = this.deps.staleDetector.checkStale({
            summary: {
              id: summary.id,
              content: summary.content ?? summary.title ?? "",
              metadata: summary.metadata as Record<string, unknown> | undefined,
              createdAt: summary.createdAt,
            },
            newMessages: newerMsgs.map((m) => ({
              role: m.role,
              content: m.content,
            })),
          });

          if (staleResult.stale) {
            await this.deps.database.memory.update(summary.id, {
              staleReason: staleResult.reasons.join("; ") || "conversation_changed",
              staleSince: new Date().toISOString(),
            } as any);
            markedCount++;
          }
        } catch (err) {
          // Skip individual failures — log and continue
          console.warn(
            `[stale-detection] Failed to check summary ${summary.id}: ${(err instanceof Error ? err.message : String(err))}`,
          );
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
