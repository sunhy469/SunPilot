export interface DigitalBeingRecord {
  id: string;
  name: string;
  description?: string;
  bodyType: string;
  color?: string;
  icon?: string;
  status: string;
  currentNodeId: string;
  targetNodeId?: string;
  homeNodeId: string;
  currentTaskId?: string;
  currentActionId?: string;
  currentRunId?: string;
  conversationId?: string;
  statusText?: string;
  sleepReason?: string;
  dailyRunLimit?: number;
  dailySkillCallLimit?: number;
  tokenBudget?: number;
  usedRuns: number;
  usedSkillCalls: number;
  cooldownUntil?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDigitalBeingInput {
  id?: string;
  name: string;
  description?: string;
  bodyType?: string;
  color?: string;
  icon?: string;
  homeNodeId: string;
  currentNodeId?: string;
  conversationId?: string;
  dailyRunLimit?: number;
  dailySkillCallLimit?: number;
  tokenBudget?: number;
}

/**
 * Patch for updating a Digital Being.
 *
 * Field semantics:
 * - `undefined` (field absent): the column is left untouched.
 * - `null`: the column is explicitly cleared (written as SQL NULL).
 * - a value: the column is updated to that value.
 *
 * Callers that want to clear a nullable column (e.g. `currentTaskId` after a
 * task finishes, or `sleepReason` on wake) MUST pass `null`, not `undefined`.
 */
export interface UpdateDigitalBeingPatch {
  name?: string;
  description?: string | null;
  status?: string;
  currentNodeId?: string;
  targetNodeId?: string | null;
  currentTaskId?: string | null;
  currentActionId?: string | null;
  currentRunId?: string | null;
  statusText?: string | null;
  sleepReason?: string | null;
  usedRuns?: number;
  usedSkillCalls?: number;
  cooldownUntil?: string | null;
}

export interface DigitalBeingRepository {
  create(input: CreateDigitalBeingInput): Promise<DigitalBeingRecord>;
  findById(id: string): Promise<DigitalBeingRecord | null>;
  list(): Promise<DigitalBeingRecord[]>;
  update(id: string, patch: UpdateDigitalBeingPatch): Promise<DigitalBeingRecord | null>;
  delete(id: string): Promise<boolean>;
}
