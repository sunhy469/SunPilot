-- Align trace metadata for databases created before the unified ReAct loop.
COMMENT ON COLUMN agent_trace_spans.kind IS
  'Phase kind: context_building|tool_retrieval|react_model_turn|tool_guard|tool_executing|observation_building|checkpoint_persistence|memory_writing|approval_handling';
