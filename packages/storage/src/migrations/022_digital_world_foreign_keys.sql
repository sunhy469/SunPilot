-- 022_digital_world_foreign_keys.sql
-- 补全 digital_world 模块缺失的外键约束（见审查报告 C8）。
-- 仅对原本就 NOT NULL 的列使用 ON DELETE RESTRICT/SET NULL，已存在的引用保持兼容。

-- digital_beings → world_nodes (current_node_id, target_node_id, home_node_id)
ALTER TABLE digital_beings
  ADD CONSTRAINT IF NOT EXISTS fk_digital_beings_current_node
  FOREIGN KEY (current_node_id) REFERENCES world_nodes(id) ON DELETE RESTRICT;

ALTER TABLE digital_beings
  ADD CONSTRAINT IF NOT EXISTS fk_digital_beings_target_node
  FOREIGN KEY (target_node_id) REFERENCES world_nodes(id) ON DELETE SET NULL;

ALTER TABLE digital_beings
  ADD CONSTRAINT IF NOT EXISTS fk_digital_beings_home_node
  FOREIGN KEY (home_node_id) REFERENCES world_nodes(id) ON DELETE RESTRICT;

-- digital_beings → world_tasks / world_actions / agent_runs / conversations
ALTER TABLE digital_beings
  ADD CONSTRAINT IF NOT EXISTS fk_digital_beings_current_task
  FOREIGN KEY (current_task_id) REFERENCES world_tasks(id) ON DELETE SET NULL;

ALTER TABLE digital_beings
  ADD CONSTRAINT IF NOT EXISTS fk_digital_beings_current_action
  FOREIGN KEY (current_action_id) REFERENCES world_actions(id) ON DELETE SET NULL;

ALTER TABLE digital_beings
  ADD CONSTRAINT IF NOT EXISTS fk_digital_beings_current_run
  FOREIGN KEY (current_run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE digital_beings
  ADD CONSTRAINT IF NOT EXISTS fk_digital_beings_conversation
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

-- world_actions → world_nodes / runs
ALTER TABLE world_actions
  ADD CONSTRAINT IF NOT EXISTS fk_world_actions_from_node
  FOREIGN KEY (from_node_id) REFERENCES world_nodes(id) ON DELETE SET NULL;

ALTER TABLE world_actions
  ADD CONSTRAINT IF NOT EXISTS fk_world_actions_to_node
  FOREIGN KEY (to_node_id) REFERENCES world_nodes(id) ON DELETE SET NULL;

ALTER TABLE world_actions
  ADD CONSTRAINT IF NOT EXISTS fk_world_actions_agent_run
  FOREIGN KEY (agent_run_id) REFERENCES runs(id) ON DELETE SET NULL;

-- world_artifacts → runs / world_nodes
ALTER TABLE world_artifacts
  ADD CONSTRAINT IF NOT EXISTS fk_world_artifacts_run
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE SET NULL;

ALTER TABLE world_artifacts
  ADD CONSTRAINT IF NOT EXISTS fk_world_artifacts_location_node
  FOREIGN KEY (location_node_id) REFERENCES world_nodes(id) ON DELETE RESTRICT;
