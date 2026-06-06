-- 010_agent_observability: Approvals, artifacts, and audit enhancements
-- Architecture doc §20.8, §20.9, §20.11 — adds observability fields.

-- Enhance approvals table
ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS decided_by TEXT;

CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_expires ON approvals(status, expires_at)
  WHERE status = 'pending';

-- Enhance artifacts table
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS storage_key TEXT,
  ADD COLUMN IF NOT EXISTS checksum TEXT,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_artifacts_conversation
  ON artifacts(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_storage_key
  ON artifacts(storage_key)
  WHERE storage_key IS NOT NULL;

-- Enhance audit_logs table
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS resource_type TEXT,
  ADD COLUMN IF NOT EXISTS resource_id TEXT,
  ADD COLUMN IF NOT EXISTS ip TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
