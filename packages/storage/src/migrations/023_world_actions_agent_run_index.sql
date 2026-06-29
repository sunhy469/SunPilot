-- Speed up Digital World completion callbacks that locate an action by Agent Run.
CREATE INDEX IF NOT EXISTS idx_world_actions_agent_run
  ON world_actions(agent_run_id)
  WHERE agent_run_id IS NOT NULL;
