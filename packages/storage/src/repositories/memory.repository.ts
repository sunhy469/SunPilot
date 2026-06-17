import type {
  MemoryRecord,
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
>;

export interface MemoryRepository {
  create(input: MemoryRecord): Promise<MemoryRecord>;
  update(id: string, input: UpdateMemoryInput): Promise<MemoryRecord | null>;
  list(input?: ListMemoryInput): Promise<MemoryRecord[]>;
  search(input?: MemorySearchInput): Promise<RetrievedMemoryRecord[]>;
  markAccessed(id: string, accessedAt?: string): Promise<void>;
  supersede(id: string, supersededBy: string): Promise<void>;
  softDelete(id: string, reason: string, deletedAt?: string): Promise<void>;
}
