export interface WorldTaskRecord {
  id: string;
  beingId: string;
  type: string;
  status: string;
  title: string;
  input: Record<string, unknown>;
  currentActionId?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CreateWorldTaskInput {
  id?: string;
  beingId: string;
  type: string;
  title: string;
  input?: Record<string, unknown>;
}

export interface UpdateWorldTaskPatch {
  status?: string;
  currentActionId?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface WorldTaskRepository {
  create(input: CreateWorldTaskInput): Promise<WorldTaskRecord>;
  findById(id: string): Promise<WorldTaskRecord | null>;
  listByBeingId(beingId: string): Promise<WorldTaskRecord[]>;
  update(id: string, patch: UpdateWorldTaskPatch): Promise<WorldTaskRecord | null>;
  /**
   * Atomically claim a queued task by conditional UPDATE.
   * Only succeeds if the task is still `queued`; sets it to `running` and
   * returns the updated record. Returns null if the task is missing or no
   * longer queued (already claimed by another executor, or in a terminal
   * state). This prevents the SELECT-then-UPDATE race where two concurrent
   * executors both see `queued` and both proceed.
   */
  claimIfQueued(id: string, startedAt: string): Promise<WorldTaskRecord | null>;
}
