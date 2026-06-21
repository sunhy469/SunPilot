export interface WorldArtifactRecord {
  id: string;
  beingId: string;
  taskId?: string;
  runId?: string;
  type: string;
  title: string;
  uri?: string;
  thumbnailUri?: string;
  locationNodeId: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateWorldArtifactInput {
  id?: string;
  beingId: string;
  taskId?: string;
  runId?: string;
  type: string;
  title: string;
  uri?: string;
  thumbnailUri?: string;
  locationNodeId: string;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateWorldArtifactPatch {
  status?: string;
  uri?: string;
  thumbnailUri?: string;
  metadata?: Record<string, unknown>;
}

export interface WorldArtifactRepository {
  create(input: CreateWorldArtifactInput): Promise<WorldArtifactRecord>;
  findById(id: string): Promise<WorldArtifactRecord | null>;
  listByBeingId(beingId: string): Promise<WorldArtifactRecord[]>;
  update(id: string, patch: UpdateWorldArtifactPatch): Promise<WorldArtifactRecord | null>;
}
