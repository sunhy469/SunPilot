CREATE TABLE IF NOT EXISTS digital_beings (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  body_type TEXT NOT NULL DEFAULT 'tracked_worker',
  color TEXT,
  icon TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  current_node_id TEXT NOT NULL,
  target_node_id TEXT,
  home_node_id TEXT NOT NULL,
  current_task_id TEXT,
  current_action_id TEXT,
  current_run_id TEXT,
  conversation_id TEXT,
  status_text TEXT,
  sleep_reason TEXT,
  daily_run_limit INTEGER,
  daily_skill_call_limit INTEGER,
  token_budget INTEGER,
  used_runs INTEGER NOT NULL DEFAULT 0,
  used_skill_calls INTEGER NOT NULL DEFAULT 0,
  cooldown_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS world_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  pos_x REAL NOT NULL,
  pos_y REAL NOT NULL,
  size_width REAL NOT NULL,
  size_height REAL NOT NULL,
  icon TEXT,
  logo TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS world_edges (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES world_nodes(id) ON DELETE CASCADE,
  to_node_id TEXT NOT NULL REFERENCES world_nodes(id) ON DELETE CASCADE,
  distance REAL NOT NULL DEFAULT 1,
  bidirectional BOOLEAN NOT NULL DEFAULT TRUE,
  locked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS world_tasks (
  id TEXT PRIMARY KEY,
  being_id TEXT NOT NULL REFERENCES digital_beings(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  title TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}',
  current_action_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS world_actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES world_tasks(id) ON DELETE CASCADE,
  being_id TEXT NOT NULL REFERENCES digital_beings(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  from_node_id TEXT,
  to_node_id TEXT,
  route_node_ids JSONB,
  agent_run_id TEXT,
  status_text TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  error JSONB,
  params JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS world_artifacts (
  id TEXT PRIMARY KEY,
  being_id TEXT NOT NULL REFERENCES digital_beings(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES world_tasks(id) ON DELETE SET NULL,
  run_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  uri TEXT,
  thumbnail_uri TEXT,
  location_node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS world_action_logs (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES world_actions(id) ON DELETE CASCADE,
  being_id TEXT NOT NULL REFERENCES digital_beings(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_world_edges_from ON world_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_world_edges_to ON world_edges(to_node_id);
CREATE INDEX IF NOT EXISTS idx_world_tasks_being ON world_tasks(being_id);
CREATE INDEX IF NOT EXISTS idx_world_actions_task ON world_actions(task_id);
CREATE INDEX IF NOT EXISTS idx_world_actions_being ON world_actions(being_id);
CREATE INDEX IF NOT EXISTS idx_world_artifacts_being ON world_artifacts(being_id);
CREATE INDEX IF NOT EXISTS idx_world_action_logs_action ON world_action_logs(action_id);
CREATE INDEX IF NOT EXISTS idx_world_action_logs_being ON world_action_logs(being_id);
CREATE INDEX IF NOT EXISTS idx_digital_beings_conversation ON digital_beings(conversation_id);
