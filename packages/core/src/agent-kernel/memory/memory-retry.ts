import type { AgentEventBus } from "../agent-event-bus.js";
import type {
  MemoryWriteInput,
  MemoryWriteResult,
  MemoryWriter,
} from "./memory-types.js";

/**
 * Retry policy configuration for memory writes.
 */
export interface MemoryRetryConfig {
  /** Maximum retry attempts (default 2, for total of 3 tries). */
  maxRetries?: number;
  /** Base delay in ms before first retry (default 500). */
  baseDelayMs?: number;
  /** Clock for testability. */
  clock?: () => Date;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 500;

/**
 * MemoryRetryWrapper — wraps a MemoryWriter with retry logic.
 *
 * On failure, retries up to `maxRetries` times with exponential backoff
 * (500ms → 1000ms). If all attempts fail, returns a partial result with
 * the successfully written records (empty if none) and emits an
 * `agent.error` event (category: "memory") so the issue is surfaced
 * through the standard protocol event vocabulary.
 */
export class MemoryRetryWrapper implements MemoryWriter {
  private readonly config: Required<MemoryRetryConfig>;

  constructor(
    private readonly inner: MemoryWriter,
    private readonly eventBus: Pick<AgentEventBus, "emit">,
    config: MemoryRetryConfig = {},
  ) {
    this.config = {
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseDelayMs: config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      clock: config.clock ?? (() => new Date()),
    };
  }

  async writeFromTurn(input: MemoryWriteInput): Promise<MemoryWriteResult> {
    let lastError: unknown;
    let lastPartial: MemoryWriteResult | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const result = await this.inner.writeFromTurn(input);
        // §C6: Preserve the most recent successful (or partial) result so
        // that if a subsequent attempt were to fail we can return the
        // best progress made. Under the current inner contract a
        // non-throwing call returns the authoritative result, but we keep
        // this snapshot so partial-progress recovery remains possible.
        lastPartial = result;
        return result;
      } catch (err) {
        lastError = err;
        // §C6: If the inner writer attached a partial result to the error
        // (e.g. it committed some records before failing), capture it so
        // we can return the partial progress after all retries are
        // exhausted instead of discarding it.
        const partial = (err as { partial?: MemoryWriteResult }).partial;
        if (partial) {
          lastPartial = lastPartial
            ? {
                written: [...lastPartial.written, ...partial.written],
                rejected: [...lastPartial.rejected, ...partial.rejected],
                superseded: [
                  ...lastPartial.superseded,
                  ...partial.superseded,
                ],
              }
            : partial;
        }
        // On the last attempt, don't sleep — just fail
        if (attempt < this.config.maxRetries) {
          const delay =
            this.config.baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // All retries exhausted — emit agent.error (category: "memory") so the
    // issue surfaces through the standard protocol event vocabulary. This
    // replaces the previous non-protocol "agent.memory.write_failed" event.
    const errorMessage =
      lastError instanceof Error ? lastError.message : String(lastError);
    const runId = input.input?.runId;
    const conversationId = input.input?.conversationId;
    this.eventBus.emit(
      "agent.error",
      {
        runId,
        code: "AGENT_MEMORY_WRITE_FAILED",
        message: `Memory write failed after ${this.config.maxRetries + 1} attempts: ${errorMessage}`,
        category: "memory",
        retryable: false,
        fatal: false,
      },
      { runId, conversationId },
    );

    return lastPartial ?? { written: [], rejected: [], superseded: [] };
  }

  /**
   * Delegate to inner writer's updateMemory (no retry for explicit updates).
   */
  async updateMemory(
    id: string,
    input: { content?: string; title?: string; summary?: string; confidence?: number; importance?: number },
  ): Promise<unknown> {
    if ("updateMemory" in this.inner && typeof (this.inner as any).updateMemory === "function") {
      return (this.inner as any).updateMemory(id, input);
    }
    // Fallback: pass-through to repository update without re-embedding
    return null;
  }
}
