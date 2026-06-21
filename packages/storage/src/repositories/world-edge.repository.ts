export interface WorldEdgeRecord {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  distance: number;
  bidirectional: boolean;
  locked: boolean;
}

export interface CreateWorldEdgeInput {
  id?: string;
  fromNodeId: string;
  toNodeId: string;
  distance?: number;
  bidirectional?: boolean;
  locked?: boolean;
}

export interface WorldEdgeRepository {
  create(input: CreateWorldEdgeInput): Promise<WorldEdgeRecord>;
  findById(id: string): Promise<WorldEdgeRecord | null>;
  list(): Promise<WorldEdgeRecord[]>;
  delete(id: string): Promise<boolean>;
}
