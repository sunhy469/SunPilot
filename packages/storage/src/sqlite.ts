import { appendFileSync } from "node:fs";
import Database from "better-sqlite3";
import type {
  ApprovalRecord,
  ArtifactRecord,
  InstalledSkillRecord,
  MemoryRecord,
  SkillManifest,
  RunRecord,
  StepRecord,
  SunPilotEvent,
  WorkflowRecord
} from "@sunpilot/protocol";
import { ensureSunPilotHome, getSunPilotPaths, type SunPilotPaths } from "./paths.js";
import { redactSensitive } from "./redaction.js";

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}

function optionalText(value: string | null): string | undefined {
  return value ?? undefined;
}

export class SunPilotDatabase {
  readonly db: Database.Database;
  readonly paths: SunPilotPaths;
  private readonly eventSubscribers = new Set<(event: SunPilotEvent) => void>();

  constructor(paths = getSunPilotPaths()) {
    this.paths = ensureSunPilotHome(paths);
    this.db = new Database(this.paths.db);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        workflow_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        input_json TEXT NOT NULL,
        context_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        parent_step_id TEXT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        workflow_id TEXT,
        skill_id TEXT,
        capability TEXT,
        input_json TEXT NOT NULL,
        output_json TEXT,
        error_json TEXT,
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS installed_skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        manifest_json TEXT NOT NULL,
        readme_summary TEXT,
        installed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS skill_permissions (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        permission_json TEXT NOT NULL,
        granted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        source TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT,
        status TEXT NOT NULL,
        risk TEXT NOT NULL,
        title TEXT NOT NULL,
        reason TEXT NOT NULL,
        requested_action_json TEXT NOT NULL,
        decision_json TEXT,
        created_at TEXT NOT NULL,
        decided_at TEXT,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_id TEXT,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(run_id) REFERENCES runs(id)
      );
      CREATE TABLE IF NOT EXISTS memory_metadata (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        step_id TEXT,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_auth_sessions (
        id TEXT PRIMARY KEY,
        token_hint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        step_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        risk TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS job_queue (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        timeout_at TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureColumn("job_queue", "timeout_at", "TEXT");
    this.ensureColumn("memory_metadata", "step_id", "TEXT");
    this.ensureColumn("memory_metadata", "value_json", "TEXT NOT NULL DEFAULT 'null'");
  }

  recoverInterrupted(): void {
    const now = new Date().toISOString();
    const interruptedRuns = this.listRuns().filter((item) => ["queued", "planning", "running"].includes(item.status));
    for (const run of interruptedRuns) {
      this.updateRunStatus(run.id, "interrupted", now);
      this.appendEvent({
        id: `evt_${crypto.randomUUID()}`,
        runId: run.id,
        type: "run.interrupted",
        payload: { reason: "daemon restarted while run was unfinished" },
        createdAt: now
      });
      this.db
        .prepare("UPDATE steps SET status = 'interrupted', completed_at = ? WHERE run_id = ? AND status IN ('pending', 'running', 'waiting_approval')")
        .run(now, run.id);
      this.updateJobStatus(run.id, "interrupted");
    }
    this.expireTimedOutJobs(now);
  }

  upsertWorkflow(workflow: WorkflowRecord): void {
    this.db
      .prepare(
        `INSERT INTO workflows (id, title, version, source, enabled, definition_json, created_at, updated_at)
         VALUES (@id, @title, @version, @source, @enabled, @definition, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, version = excluded.version,
         source = excluded.source, enabled = excluded.enabled, definition_json = excluded.definition_json,
         updated_at = excluded.updated_at`
      )
      .run({ ...workflow, enabled: workflow.enabled ? 1 : 0, definition: json(workflow.definition) });
  }

  listWorkflows(): WorkflowRecord[] {
    return this.db.prepare("SELECT * FROM workflows ORDER BY id").all().map((row: any) => ({
      id: row.id,
      title: row.title,
      version: row.version,
      source: row.source,
      enabled: row.enabled === 1,
      definition: parse(row.definition_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  insertRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, title, status, mode, workflow_id, created_at, updated_at, completed_at, input_json, context_json)
         VALUES (@id, @title, @status, @mode, @workflowId, @createdAt, @updatedAt, @completedAt, @input, @context)`
      )
      .run({ ...run, workflowId: run.workflowId ?? null, completedAt: run.completedAt ?? null, input: json(run.input), context: json(run.context) });
  }

  updateRunContext(id: string, context: Record<string, unknown>): void {
    this.db.prepare("UPDATE runs SET context_json = ?, updated_at = ? WHERE id = ?").run(json(context), new Date().toISOString(), id);
  }

  updateRunStatus(id: string, status: RunRecord["status"], completedAt?: string): void {
    this.db
      .prepare("UPDATE runs SET status = ?, updated_at = ?, completed_at = COALESCE(?, completed_at) WHERE id = ?")
      .run(status, new Date().toISOString(), completedAt ?? null, id);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return this.mapRun(row);
  }

  listRuns(): RunRecord[] {
    return this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC").all().map((row: any) => this.mapRun(row));
  }

  insertStep(step: StepRecord): void {
    this.db
      .prepare(
        `INSERT INTO steps (id, run_id, parent_step_id, type, name, status, workflow_id, skill_id, capability, input_json, output_json, error_json, started_at, completed_at)
         VALUES (@id, @runId, @parentStepId, @type, @name, @status, @workflowId, @skillId, @capability, @input, @output, @error, @startedAt, @completedAt)`
      )
      .run({
        ...step,
        parentStepId: step.parentStepId ?? null,
        workflowId: step.workflowId ?? null,
        skillId: step.skillId ?? null,
        capability: step.capability ?? null,
        input: json(step.input),
        output: step.output === undefined ? null : json(step.output),
        error: step.error === undefined ? null : json(step.error),
        startedAt: step.startedAt ?? null,
        completedAt: step.completedAt ?? null
      });
  }

  updateStep(stepId: string, status: StepRecord["status"], output?: unknown, error?: unknown): void {
    const now = new Date().toISOString();
    const terminal = ["completed", "failed", "skipped", "canceled", "interrupted"].includes(status);
    this.db
      .prepare(
        `UPDATE steps SET status = ?, output_json = ?, error_json = ?,
         started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
         completed_at = ? WHERE id = ?`
      )
      .run(status, output === undefined ? null : json(output), error === undefined ? null : json(error), status, now, terminal ? now : null, stepId);
  }

  listSteps(runId: string): StepRecord[] {
    return this.db.prepare("SELECT * FROM steps WHERE run_id = ? ORDER BY rowid").all(runId).map((row: any) => ({
      id: row.id,
      runId: row.run_id,
      parentStepId: optionalText(row.parent_step_id),
      type: row.type,
      name: row.name,
      status: row.status,
      workflowId: optionalText(row.workflow_id),
      skillId: optionalText(row.skill_id),
      capability: optionalText(row.capability),
      input: parse(row.input_json, {}),
      output: parse(row.output_json, undefined),
      error: parse(row.error_json, undefined),
      startedAt: optionalText(row.started_at),
      completedAt: optionalText(row.completed_at)
    }));
  }

  appendEvent(event: SunPilotEvent): void {
    this.db
      .prepare("INSERT INTO events (id, run_id, step_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, event.runId, event.stepId ?? null, event.type, json(event.payload), event.createdAt);
    for (const subscriber of this.eventSubscribers) subscriber(event);
  }

  subscribeEvents(subscriber: (event: SunPilotEvent) => void): () => void {
    this.eventSubscribers.add(subscriber);
    return () => this.eventSubscribers.delete(subscriber);
  }

  listEvents(runId: string): SunPilotEvent[] {
    return this.db.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY created_at, rowid").all(runId).map((row: any) => ({
      id: row.id,
      runId: row.run_id,
      stepId: optionalText(row.step_id),
      type: row.type,
      payload: parse(row.payload_json, {}),
      createdAt: row.created_at
    }));
  }

  upsertSkill(skill: InstalledSkillRecord): void {
    this.db
      .prepare(
        `INSERT INTO installed_skills (id, name, version, path, enabled, manifest_json, readme_summary, installed_at, updated_at)
         VALUES (@id, @name, @version, @path, @enabled, @manifest, @readmeSummary, @installedAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, version = excluded.version, path = excluded.path,
         enabled = excluded.enabled, manifest_json = excluded.manifest_json, readme_summary = excluded.readme_summary,
         updated_at = excluded.updated_at`
      )
      .run({ ...skill, enabled: skill.enabled ? 1 : 0, manifest: json(skill.manifest), readmeSummary: skill.readmeSummary ?? null });
  }

  listSkills(): InstalledSkillRecord[] {
    return this.db.prepare("SELECT * FROM installed_skills ORDER BY id").all().map((row: any) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      path: row.path,
      enabled: row.enabled === 1,
      manifest: parse<SkillManifest>(row.manifest_json, {} as SkillManifest),
      readmeSummary: optionalText(row.readme_summary),
      installedAt: row.installed_at,
      updatedAt: row.updated_at
    }));
  }

  setSkillEnabled(id: string, enabled: boolean): InstalledSkillRecord | undefined {
    this.db.prepare("UPDATE installed_skills SET enabled = ?, updated_at = ? WHERE id = ?").run(enabled ? 1 : 0, new Date().toISOString(), id);
    return this.getSkill(id);
  }

  getSkill(id: string): InstalledSkillRecord | undefined {
    const row = this.db.prepare("SELECT * FROM installed_skills WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      path: row.path,
      enabled: row.enabled === 1,
      manifest: parse<SkillManifest>(row.manifest_json, {} as SkillManifest),
      readmeSummary: optionalText(row.readme_summary),
      installedAt: row.installed_at,
      updatedAt: row.updated_at
    };
  }

  insertApproval(approval: ApprovalRecord): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, run_id, step_id, status, risk, title, reason, requested_action_json, decision_json, created_at, decided_at)
         VALUES (@id, @runId, @stepId, @status, @risk, @title, @reason, @requestedAction, @decision, @createdAt, @decidedAt)`
      )
      .run({
        ...approval,
        stepId: approval.stepId ?? null,
        requestedAction: json(approval.requestedAction),
        decision: approval.decision === undefined ? null : json(approval.decision),
        decidedAt: approval.decidedAt ?? null
      });
  }

  decideApproval(id: string, status: "approved" | "rejected", decision: unknown): ApprovalRecord | undefined {
    const decidedAt = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE approvals SET status = ?, decision_json = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, json(decision), decidedAt, id);
    return result.changes > 0 ? this.getApproval(id) : undefined;
  }

  getApproval(id: string): ApprovalRecord | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return this.mapApproval(row);
  }

  listApprovals(): ApprovalRecord[] {
    return this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC").all().map((row: any) => this.mapApproval(row));
  }

  insertArtifact(artifact: ArtifactRecord): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, run_id, step_id, type, name, path, mime_type, size_bytes, metadata_json, created_at)
         VALUES (@id, @runId, @stepId, @type, @name, @path, @mimeType, @sizeBytes, @metadata, @createdAt)`
      )
      .run({
        ...artifact,
        stepId: artifact.stepId ?? null,
        mimeType: artifact.mimeType ?? null,
        sizeBytes: artifact.sizeBytes ?? null,
        metadata: json(artifact.metadata)
      });
  }

  listArtifacts(runId?: string): ArtifactRecord[] {
    const rows = runId
      ? this.db.prepare("SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at DESC").all(runId)
      : this.db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all();
    return rows.map((row: any) => this.mapArtifact(row));
  }

  getArtifact(id: string): ArtifactRecord | undefined {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return this.mapArtifact(row);
  }

  insertMemory(memory: MemoryRecord): void {
    this.db
      .prepare("INSERT INTO memory_metadata (id, run_id, step_id, key, value_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(memory.id, memory.runId ?? null, memory.stepId ?? null, memory.key, json(memory.value), json(memory.metadata), memory.createdAt);
  }

  listMemory(filter: { runId?: string; key?: string } = {}): MemoryRecord[] {
    const clauses: string[] = [];
    const values: string[] = [];
    if (filter.runId) {
      clauses.push("run_id = ?");
      values.push(filter.runId);
    }
    if (filter.key) {
      clauses.push("key = ?");
      values.push(filter.key);
    }
    const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    const rows = this.db.prepare("SELECT * FROM memory_metadata" + where + " ORDER BY created_at DESC, rowid DESC").all(...values);
    return rows.map((row: any) => ({
      id: row.id,
      runId: optionalText(row.run_id),
      stepId: optionalText(row.step_id),
      key: row.key,
      value: parse(row.value_json, undefined),
      metadata: parse(row.metadata_json, {}),
      createdAt: row.created_at
    }));
  }

  audit(record: { runId?: string; stepId?: string; actor: string; action: string; target: string; risk?: string; payload: unknown }): void {
    const createdAt = new Date().toISOString();
    const id = crypto.randomUUID();
    const safeRecord = redactSensitive(record, [this.paths.home]) as typeof record;
    this.db
      .prepare(
        "INSERT INTO audit_logs (id, run_id, step_id, actor, action, target, risk, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, safeRecord.runId ?? null, safeRecord.stepId ?? null, safeRecord.actor, safeRecord.action, safeRecord.target, safeRecord.risk ?? null, json(safeRecord.payload), createdAt);
    appendFileSync(this.paths.logs + "/audit.log", JSON.stringify({ id, ...safeRecord, createdAt }) + "\n");
  }

  tableNames(): string[] {
    return this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row: any) => row.name as string);
  }

  insertJob(job: { id: string; runId: string; status: string; attempts?: number; timeoutAt?: string; payload: unknown }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO job_queue (id, run_id, status, attempts, timeout_at, payload_json, created_at, updated_at)
         VALUES (@id, @runId, @status, @attempts, @timeoutAt, @payload, @createdAt, @updatedAt)`
      )
      .run({ id: job.id, runId: job.runId, status: job.status, attempts: job.attempts ?? 0, timeoutAt: job.timeoutAt ?? null, payload: json(job.payload), createdAt: now, updatedAt: now });
  }

  updateJobStatus(runId: string, status: string, incrementAttempts = false): void {
    this.db
      .prepare(`UPDATE job_queue SET status = ?, attempts = attempts + ?, updated_at = ? WHERE run_id = ?`)
      .run(status, incrementAttempts ? 1 : 0, new Date().toISOString(), runId);
  }

  expireTimedOutJobs(now = new Date().toISOString()): string[] {
    const rows = this.db
      .prepare("SELECT run_id FROM job_queue WHERE timeout_at IS NOT NULL AND timeout_at <= ? AND status IN ('pending', 'running')")
      .all(now) as Array<{ run_id: string }>;
    for (const row of rows) {
      this.updateJobStatus(row.run_id, "failed");
      this.updateRunStatus(row.run_id, "failed", now);
      this.appendEvent({
        id: `evt_${crypto.randomUUID()}`,
        runId: row.run_id,
        type: "run.failed",
        payload: { reason: "job timed out" },
        createdAt: now
      });
    }
    return rows.map((row) => row.run_id);
  }

  listJobs(runId?: string): Array<{ id: string; runId: string; status: string; attempts: number; timeoutAt?: string; payload: unknown; createdAt: string; updatedAt: string }> {
    const rows = runId
      ? this.db.prepare("SELECT * FROM job_queue WHERE run_id = ? ORDER BY created_at, rowid").all(runId)
      : this.db.prepare("SELECT * FROM job_queue ORDER BY created_at, rowid").all();
    return rows.map((row: any) => ({
      id: row.id,
      runId: row.run_id,
      status: row.status,
      attempts: row.attempts,
      timeoutAt: optionalText(row.timeout_at),
      payload: parse(row.payload_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  listAuditLogs(runId?: string): Array<{ id: string; runId?: string; stepId?: string; actor: string; action: string; target: string; risk?: string; payload: unknown; createdAt: string }> {
    const rows = runId
      ? this.db.prepare("SELECT * FROM audit_logs WHERE run_id = ? ORDER BY created_at, rowid").all(runId)
      : this.db.prepare("SELECT * FROM audit_logs ORDER BY created_at, rowid").all();
    return rows.map((row: any) => ({
      id: row.id,
      runId: optionalText(row.run_id),
      stepId: optionalText(row.step_id),
      actor: row.actor,
      action: row.action,
      target: row.target,
      risk: optionalText(row.risk),
      payload: parse(row.payload_json, {}),
      createdAt: row.created_at
    }));
  }

  private mapRun(row: any): RunRecord {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      mode: row.mode,
      workflowId: optionalText(row.workflow_id),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: optionalText(row.completed_at),
      input: parse(row.input_json, {}),
      context: parse(row.context_json, {})
    };
  }

  private mapApproval(row: any): ApprovalRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepId: optionalText(row.step_id),
      status: row.status,
      risk: row.risk,
      title: row.title,
      reason: row.reason,
      requestedAction: parse(row.requested_action_json, {}),
      decision: parse(row.decision_json, undefined),
      createdAt: row.created_at,
      decidedAt: optionalText(row.decided_at)
    };
  }

  private mapArtifact(row: any): ArtifactRecord {
    return {
      id: row.id,
      runId: row.run_id,
      stepId: optionalText(row.step_id),
      type: row.type,
      name: row.name,
      path: row.path,
      mimeType: optionalText(row.mime_type),
      sizeBytes: row.size_bytes ?? undefined,
      metadata: parse(row.metadata_json, {}),
      createdAt: row.created_at
    };
  }
}
