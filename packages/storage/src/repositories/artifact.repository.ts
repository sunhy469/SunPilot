import type { ArtifactRecord } from "@sunpilot/protocol";

export interface ArtifactRepository {
  create(input: ArtifactRecord): Promise<ArtifactRecord>;
  findById(id: string): Promise<ArtifactRecord | null>;
  list(runId?: string): Promise<ArtifactRecord[]>;
}
