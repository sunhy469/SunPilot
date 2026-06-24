import type {
  MemoryRecord,
  MemoryRelationEntry,
  MemorySearchInput,
  RetrievedMemoryRecord,
} from "@sunpilot/protocol";

export type ListMemoryInput = MemorySearchInput;
export type UpdateMemoryInput = Partial<
  Pick<
    MemoryRecord,
    | "key"
    | "value"
    | "scope"
    | "scopeId"
    | "type"
    | "title"
    | "content"
    | "summary"
    | "source"
    | "confidence"
    | "importance"
    | "metadata"
    | "expiresAt"
    | "staleReason"
    | "staleSince"
  >
> & {
  /** New embedding vector — used when content is updated and needs re-embedding. */
  embedding?: number[];
  /** Quality score (0-1 composite). */
  qualityScore?: number;
  /** Quality metadata JSON. */
  qualityMetadata?: Record<string, unknown>;
};

export interface MemoryRepository {
  create(input: MemoryRecord): Promise<MemoryRecord>;
  update(id: string, input: UpdateMemoryInput): Promise<MemoryRecord | null>;
  list(input?: ListMemoryInput): Promise<MemoryRecord[]>;
  search(input?: MemorySearchInput): Promise<RetrievedMemoryRecord[]>;
  markAccessed(id: string, accessedAt?: string): Promise<void>;
  supersede(id: string, supersededBy: string): Promise<void>;
  softDelete(id: string, reason: string, deletedAt?: string): Promise<void>;

  /** Persist relations from a memory to related memories. */
  saveRelations(memoryId: string, relations: MemoryRelationEntry[]): Promise<void>;
  /** Find memories related to the given one (for multi-hop retrieval). */
  findRelated(memoryId: string, relation?: string, limit?: number): Promise<RetrievedMemoryRecord[]>;
  /** Physically delete rows where the given column is older than a cutoff. */
  hardDeleteOlderThan(column: string, before: string): Promise<number>;
  /** Physically delete superseded memories where updated_at is older than cutoff. */
  hardDeleteSupersededOlderThan(before: string): Promise<number>;
}
