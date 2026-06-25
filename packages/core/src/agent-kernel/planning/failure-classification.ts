/**
 * Check if a tool failure is likely repairable (retry with fixed params).
 *
 * Shared between the Replanner (planning) and the BasicReflectionEngine
 * (reflection) so the failure-classification logic stays in one place.
 *
 * Patterns considered repairable:
 *   - timeout / transient / temporary / retry — transient errors
 *   - rate limit — back off and retry
 *   - invalid (parameter|argument|input) — fix the arguments and retry
 *   - missing (parameter|argument|field|required) — supply the missing arg
 *   - connection refused — network may recover
 */
export function isRepairableFailure(summary: string): boolean {
  return (
    /timeout/i.test(summary) ||
    /transient/i.test(summary) ||
    /rate limit/i.test(summary) ||
    /invalid (parameter|argument|input)/i.test(summary) ||
    /missing (parameter|argument|field|required)/i.test(summary) ||
    /connection refused/i.test(summary) ||
    /temporary/i.test(summary) ||
    /retry/i.test(summary)
  );
}
