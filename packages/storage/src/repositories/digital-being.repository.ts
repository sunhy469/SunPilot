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

export interface UpdateDigitalBeingPatch {
  name?: string;
  description?: string;
  status?: string;
  currentNodeId?: string;
  targetNodeId?: string;
  currentTaskId?: string;
  currentActionId?: string;
  currentRunId?: string;
  statusText?: string;
  sleepReason?: string;
  usedRuns?: number;
  usedSkillCalls?: number;
  cooldownUntil?: string;
}

export interface DigitalBeingRepository {
  create(input: CreateDigitalBeingInput): Promise<DigitalBeingRecord>;
  findById(id: string): Promise<DigitalBeingRecord | null>;
  list(): Promise<DigitalBeingRecord[]>;
  update(id: string, patch: UpdateDigitalBeingPatch): Promise<DigitalBeingRecord | null>;
  delete(id: string): Promise<boolean>;
}
