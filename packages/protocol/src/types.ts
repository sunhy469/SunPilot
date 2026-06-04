export type RunMode = "chat" | "plan" | "auto" | "approval_required" | "dry_run";

export type RunStatus =
  | "queued"
  | "planning"
  | "waiting_approval"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "canceled"
  | "interrupted";

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "canceled"
  | "interrupted";

export type SkillRisk = "low" | "medium" | "high" | "critical";

export type SunPilotEventType =
  | "run.created"
  | "run.planning"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.canceled"
  | "run.interrupted"
  | "workflow.selected"
  | "workflow.planned"
  | "step.created"
  | "step.started"
  | "step.progress"
  | "step.completed"
  | "step.failed"
  | "step.interrupted"
  | "skill.loaded"
  | "skill.execution.started"
  | "skill.execution.completed"
  | "skill.execution.failed"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "artifact.created"
  | "memory.written"
  | "audit.written";

export type ArtifactType =
  | "text"
  | "markdown"
  | "json"
  | "image"
  | "video"
  | "audio"
  | "csv"
  | "xlsx"
  | "pdf"
  | "html"
  | "directory"
  | "other";

export interface RunRecord {
  id: string;
  title: string;
  status: RunStatus;
  mode: RunMode;
  workflowId?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  input: unknown;
  context: Record<string, unknown>;
}

export interface StepRecord {
  id: string;
  runId: string;
  parentStepId?: string;
  type: "skill" | "approval" | "builtin" | "manual";
  name: string;
  status: StepStatus;
  workflowId?: string;
  skillId?: string;
  capability?: string;
  input: unknown;
  output?: unknown;
  error?: unknown;
  startedAt?: string;
  completedAt?: string;
}

export interface SunPilotEvent {
  id: string;
  runId: string;
  stepId?: string;
  type: SunPilotEventType;
  payload: unknown;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  stepId?: string;
  status: "pending" | "approved" | "rejected" | "expired";
  risk: "medium" | "high" | "critical";
  title: string;
  reason: string;
  requestedAction: unknown;
  decision?: unknown;
  createdAt: string;
  decidedAt?: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  stepId?: string;
  type: ArtifactType;
  name: string;
  path: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface MemoryRecord {
  id: string;
  runId?: string;
  stepId?: string;
  key: string;
  value: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowStepPlan {
  id: string;
  name: string;
  type: "skill" | "approval" | "builtin" | "manual";
  providerId?: string;
  capability?: string;
  input: unknown;
  dependsOn?: string[];
  risk?: SkillRisk;
}

export interface WorkflowPlan {
  runTitle: string;
  steps: WorkflowStepPlan[];
  expectedArtifacts?: Array<{ name: string; type: ArtifactType }>;
  riskSummary?: { risk: SkillRisk; reason: string };
}

export interface WorkflowRecord {
  id: string;
  title: string;
  version: string;
  source: string;
  enabled: boolean;
  definition: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionDeclaration {
  filesystem?: { read?: string[]; write?: string[] };
  network?: { allow?: string[] };
  env?: { allow?: string[] };
  shell?: boolean;
}

export interface SkillManifestCapability {
  name: string;
  title: string;
  description: string;
  inputSchema: string | Record<string, unknown>;
  outputSchema: string | Record<string, unknown>;
  risk: SkillRisk;
  permissions: string[];
}

export interface SkillManifest {
  schemaVersion: "sunpilot.skill/v1";
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  readme: string;
  author?: { name: string };
  runtime: { node: string; module: "esm" };
  capabilities: SkillManifestCapability[];
  permissions: PermissionDeclaration;
}

export interface InstalledSkillRecord {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  manifest: SkillManifest;
  readmeSummary?: string;
  installedAt: string;
  updatedAt: string;
}
