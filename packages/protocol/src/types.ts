import type { AgentEventType } from "./agent-events.js";

// ── Run mode ──────────────────────────────────────────────────────

export const RUN_MODES = ["chat", "agent"] as const;
export type RunMode = (typeof RUN_MODES)[number];

// ── Run status — single source of truth ────────────────────────────

export const RUN_STATUSES = [
  "created",
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "waiting_approval",
  "executing",
  "observing",
  "reflecting",
  "responding",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const AGENT_ACTIVE_STATUSES = [
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "waiting_approval",
  "executing",
  "observing",
  "reflecting",
  "responding",
] as const satisfies readonly RunStatus[];

export const AGENT_RECOVERABLE_STATUSES = [
  "context_building",
  "intent_routing",
  "planning",
  "tool_deciding",
  "executing",
  "observing",
  "reflecting",
  "responding",
] as const satisfies readonly RunStatus[];

export const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly RunStatus[];

// ── Step status ────────────────────────────────────────────────────

export type StepStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "interrupted";

// ── Risk ───────────────────────────────────────────────────────────

export type SkillRisk = "low" | "medium" | "high" | "critical";

// ── Event type (agent.* namespace only) ────────────────────────────
// AgentEventType is the single canonical event type for the agent.* namespace.

// ── Artifact ───────────────────────────────────────────────────────

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

// ── Records ────────────────────────────────────────────────────────

export interface RunRecord {
  id: string;
  title: string;
  status: RunStatus;
  mode: RunMode;
  conversationId?: string;
  userId?: string;
  goal?: string;
  error?: unknown;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
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
  conversationId?: string;
  stepId?: string;
  sequence?: number;
  type: AgentEventType;
  payload: unknown;
  createdAt: string;
}

export interface ApprovalRecord {
  id: string;
  runId: string;
  stepId?: string;
  status: "pending" | "approved" | "rejected" | "expired";
  risk: "low" | "medium" | "high" | "critical";
  title: string;
  reason: string;
  requestedAction: unknown;
  decision?: unknown;
  createdAt: string;
  expiresAt?: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface ArtifactRecord {
  id: string;
  runId: string;
  stepId?: string;
  conversationId?: string;
  type: ArtifactType;
  name: string;
  path: string;
  storageKey?: string;
  checksum?: string;
  version?: number;
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
  scope?: MemoryScope;
  scopeId?: string;
  type?: MemoryType;
  title?: string;
  content?: string;
  summary?: string;
  source?: string;
  confidence?: number;
  importance?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
  lastAccessedAt?: string;
  expiresAt?: string;
  supersededBy?: string;
  deletedAt?: string;
}

export const MEMORY_SCOPES = [
  "global",
  "user",
  "project",
  "conversation",
  "run",
] as const;

export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export const MEMORY_TYPES = [
  "user_preference",
  "project_profile",
  "technical_stack",
  "deployment_info",
  "workflow_pattern",
  "error_solution",
  "long_term_goal",
  "conversation_summary",
  "tool_observation",
  "manual_note",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemorySearchInput {
  query?: string;
  runId?: string;
  key?: string;
  userId?: string;
  projectId?: string;
  conversationId?: string;
  scopes?: MemoryScope[];
  types?: MemoryType[];
  includeDeleted?: boolean;
  limit?: number;
}

export interface RetrievedMemoryRecord extends MemoryRecord {
  score: number;
  relevance: number;
}

// ── Workflow ───────────────────────────────────────────────────────

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

// ── Skill manifest ─────────────────────────────────────────────────

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

// ── Agent wire event envelope ──────────────────────────────────────

export interface AgentWireEvent<TPayload = Record<string, unknown>> {
  jsonrpc: "2.0";
  method: AgentEventType;
  params: {
    eventId: string;
    sequence: number;
    runId?: string;
    conversationId?: string;
    createdAt: string;
    payload: TPayload;
  };
}
