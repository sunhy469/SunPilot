import type { AgentLoopStatus } from "../loop-types.js";

/**
 * Agent Loop 状态机的合法状态转换表 — 唯一权威来源。
 *
 * InMemoryRunStateManager 和 RepositoryRunStateManager 必须复用此模块。
 * 终态（completed / cancelled / failed）没有合法后续转换。
 */
export const LEGAL_TRANSITIONS: Record<AgentLoopStatus, readonly AgentLoopStatus[]> = {
  created: ["context_building", "cancelled", "failed"],
  context_building: ["intent_routing", "cancelled", "failed"],
  intent_routing: ["planning", "tool_deciding", "responding", "cancelled", "failed"],
  planning: ["tool_deciding", "waiting_approval", "cancelled", "failed"],
  tool_deciding: ["waiting_approval", "executing", "responding", "cancelled", "failed"],
  waiting_approval: ["executing", "cancelled", "failed"],
  executing: ["observing", "reflecting", "responding", "waiting_approval", "cancelled", "failed"],
  observing: ["reflecting", "responding", "cancelled", "failed"],
  reflecting: ["tool_deciding", "responding", "cancelled", "failed"],
  responding: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

/**
 * 检查 from → to 是否为合法状态转换。
 */
export function canTransition(
  from: AgentLoopStatus,
  to: AgentLoopStatus,
): boolean {
  return from === to || LEGAL_TRANSITIONS[from]?.includes(to);
}

/**
 * 如果不是合法转换则抛出 AGENT_RUN_STATE_CONFLICT 错误。
 */
export function assertLegalTransition(
  from: AgentLoopStatus,
  to: AgentLoopStatus,
  runId: string,
): void {
  if (!canTransition(from, to)) {
    throw Object.assign(
      new Error(`Illegal state transition: ${from} -> ${to} for run ${runId}`),
      { code: "AGENT_RUN_STATE_CONFLICT" },
    );
  }
}

/** 是否为终态（不可再转换）。 */
export function isTerminal(status: AgentLoopStatus): boolean {
  return LEGAL_TRANSITIONS[status]?.length === 0;
}
