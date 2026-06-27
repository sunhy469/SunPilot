/** Maximum number of native tool-call rounds in one agent run. */
export const MAX_TOOL_ITERATIONS = 5;

/** Canonical mapping from runtime phase to user-visible status label. */
export const RUN_PHASE_LABELS = {
  context_building: "正在整理上下文",
  intent_routing: "正在理解需求",
  planning: "正在制定计划",
  tool_deciding: "正在匹配工具",
  executing: "正在调用工具",
  observing: "正在整理工具结果",
  reflecting: "正在检查结果",
  responding: "正在生成回答",
  waiting_approval: "等待确认",
  stopped: "已停止",
} as const;
