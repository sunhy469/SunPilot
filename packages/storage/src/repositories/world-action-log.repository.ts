export interface WorldActionLogRecord {
  id: string;
  actionId: string;
  beingId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface CreateWorldActionLogInput {
  id?: string;
  actionId: string;
  beingId: string;
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface WorldActionLogRepository {
  create(input: CreateWorldActionLogInput): Promise<WorldActionLogRecord>;
  listByActionId(actionId: string): Promise<WorldActionLogRecord[]>;
  listByBeingId(beingId: string): Promise<WorldActionLogRecord[]>;
}
