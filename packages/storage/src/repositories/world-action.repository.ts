export interface WorldActionRecord {
  id: string;
  taskId: string;
  beingId: string;
  type: string;
  status: string;
  fromNodeId?: string;
  toNodeId?: string;
  routeNodeIds?: string[];
  agentRunId?: string;
  statusText: string;
  startedAt?: string;
  completedAt?: string;
  error?: unknown;
  params: Record<string, unknown>;
  createdAt: string;
}

export interface CreateWorldActionInput {
  id?: string;
  taskId: string;
  beingId: string;
  type: string;
  fromNodeId?: string;
  toNodeId?: string;
  routeNodeIds?: string[];
  statusText?: string;
  params?: Record<string, unknown>;
  createdAt?: string;
}

export interface UpdateWorldActionPatch {
  status?: string;
  agentRunId?: string;
  fromNodeId?: string;
  toNodeId?: string;
  routeNodeIds?: string[];
  statusText?: string;
  startedAt?: string;
  completedAt?: string;
  error?: unknown;
}

export interface WorldActionRepository {
  create(input: CreateWorldActionInput): Promise<WorldActionRecord>;
  findById(id: string): Promise<WorldActionRecord | null>;
  listByTaskId(taskId: string): Promise<WorldActionRecord[]>;
  listByBeingId(beingId: string): Promise<WorldActionRecord[]>;
  update(id: string, patch: UpdateWorldActionPatch): Promise<WorldActionRecord | null>;
  /**
   * Find the in-flight action that owns the given Agent Run.
   * Backed by `idx_world_actions_agent_run` — replaces the previous
   * O(beings × actions) application-layer scan in TaskExecutor.
   */
  findByAgentRunId(runId: string): Promise<WorldActionRecord | null>;
}
