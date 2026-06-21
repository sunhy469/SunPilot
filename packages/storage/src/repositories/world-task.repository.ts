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
}
