export interface ReactLoopLimits {
  maxToolRounds: number;
  maxModelCalls: number;
  maxWallClockMs: number;
  /** Maximum number of times an identical tool action may be accepted. */
  maxRepeatedToolCalls: number;
  maxObservationTokens: number;
  finalizationReserveTokens: number;
  toolCatalogLimit: number;
}

export const DEFAULT_REACT_LOOP_LIMITS: ReactLoopLimits = {
  maxToolRounds: 8,
  maxModelCalls: 10,
  maxWallClockMs: 10 * 60_000,
  maxRepeatedToolCalls: 1,
  maxObservationTokens: 2_000,
  finalizationReserveTokens: 1_000,
  toolCatalogLimit: 12,
};

export function resolveReactLoopLimits(
  overrides: Partial<ReactLoopLimits> = {},
): ReactLoopLimits {
  const limits = { ...DEFAULT_REACT_LOOP_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid ReAct loop limit ${name}: ${value}`);
    }
  }
  if (limits.maxModelCalls < 2) {
    throw new Error("ReAct maxModelCalls must reserve at least one finalization call");
  }
  return limits;
}
