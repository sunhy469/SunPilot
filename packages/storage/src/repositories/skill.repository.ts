import type { InstalledSkillRecord } from "@sunpilot/protocol";

export interface SkillRepository {
  upsert(input: InstalledSkillRecord): Promise<InstalledSkillRecord>;
  list(): Promise<InstalledSkillRecord[]>;
  findById(id: string): Promise<InstalledSkillRecord | null>;
  setEnabled(id: string, enabled: boolean): Promise<InstalledSkillRecord | null>;
}
