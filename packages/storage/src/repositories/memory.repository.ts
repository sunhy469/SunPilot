import type { MemoryRecord } from "@sunpilot/protocol";

export interface ListMemoryInput {
  runId?: string;
  key?: string;
}

export interface MemoryRepository {
  create(input: MemoryRecord): Promise<MemoryRecord>;
  list(input?: ListMemoryInput): Promise<MemoryRecord[]>;
}
